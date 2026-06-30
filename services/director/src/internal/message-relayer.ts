import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";
import { MessageBroker } from "@/internal/message-broker";
import { MessageOutbox } from "@/internal/message-outbox";

export class MessageRelayer {
  #outbox: MessageOutbox;
  #broker: MessageBroker;

  #logger: Logger;

  constructor() {
    this.#outbox = Container.inject(MessageOutbox);
    this.#broker = Container.inject(MessageBroker);
    this.#logger = Container.inject(Logger).scope("Broker");
  }

  async run(signal: AbortSignal) {
    if (signal.aborted) {
      throw new Error("");
    }

    let wakeResolver: (() => void) | undefined;

    const unsubscribe = this.#outbox.subscribe(() => {
      wakeResolver?.();
    });

    while (!signal.aborted) {
      let records: MessageOutbox.Record[] = [];

      try {
        records = await this.#outbox.read();
      } catch (error) {
        this.#logger.errorFrom(error, "Failed to read outbox.");
        await this.#sleep(1000, signal);
        continue;
      }

      if (signal.aborted) {
        break;
      }

      // 如果读到的事件箱为空则等待产生新的事件
      if (records.length === 0) {
        await this.#waitForWake(signal, (resolver) => {
          wakeResolver = resolver;
        });
      }

      if (signal.aborted) {
        break;
      }

      let published: [id: string, timestamp: Date][] = [];

      try {
        published = await this.#publish(records);
      } catch (error) {
        this.#logger.error("Failed to publish events", { err: error });
        await this.#sleep(3000, signal);
        continue;
      }

      if (signal.aborted) {
        break;
      }

      try {
        await this.#outbox.published(published);
      } catch (error) {
        this.#logger.error("Failed to mark events as published", { err: error });
        await this.#sleep(3000, signal);
      }
    }

    unsubscribe();
  }

  async #sleep(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        return resolve();
      }

      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async #waitForWake(signal: AbortSignal, callback: (resolver: () => void) => void) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        return resolve();
      }

      const resolver = () => {
        resolve();
        signal.removeEventListener("abort", resolver);
      };

      callback(resolver);
      signal.addEventListener("abort", resolver, { once: true });
    });
  }

  async #publish(records: MessageOutbox.Record[]) {
    return await Promise.all(
      records.map(async (record) => {
        return this.#broker.exchange
          .publish(record.payload, {
            routingKey: record.topic,
            messageId: record.id,
            timestamp: record.timestamp,
            headers: {
              "x-trace-id": record.traceId,
            },
            confirm: true,
            // 找不到消费队列就直接丢弃
            mandatory: false,
            // 持久化
            deliveryMode: 2,
          })
          .then(() => {
            return {
              id: record.id,
              ok: true,
              timestamp: new Date(),
            } as const;
          })
          .catch((error) => {
            this.#logger.errorFrom(error, "Failed to publish event");

            return {
              ok: false,
            } as const;
          });
      }),
    ).then((results) => {
      const published: [id: string, timestamp: Date][] = [];

      for (const result of results) {
        if (result.ok) {
          published.push([result.id, result.timestamp]);
        }
      }

      return published;
    });
  }
}
