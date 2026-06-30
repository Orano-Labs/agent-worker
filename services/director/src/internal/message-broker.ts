import { type AMQPExchange, type AMQPMessage, type AMQPQueue, AMQPSession, type QueueSubscribeParams } from "@cloudamqp/amqp-client";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { Result } from "@/helpers/result";
import { Logger } from "@/internal/logger";
import { MessageOutbox } from "@/internal/message-outbox";
import { Variables } from "@/internal/variables";

export class MessageBroker {
  #session?: AMQPSession;
  #exchange?: AMQPExchange;
  #logger: Logger;
  #variables: Variables;

  constructor() {
    this.#variables = Container.inject(Variables);
    this.#logger = Container.inject(Logger).scope("MessageQueue");
  }

  get session() {
    if (!this.#session) {
      throw new Error("Message broker session is not available");
    }

    return this.#session;
  }

  get exchange() {
    if (!this.#exchange) {
      throw new Error("Message broker exchange is not available");
    }

    return this.#exchange;
  }

  async init(): Promise<Result<void, Error>> {
    MessageBroker.#queuesRegistryLocked = true;

    const url = this.#variables.get("AW_DIRECTOR_MQ_URL");

    if (!url) {
      return Result.error(new Error("AW_DIRECTOR_MQ_URL is not set, cannot initialize message broker."));
    }

    let session: AMQPSession;

    try {
      session = await AMQPSession.connect(url);
    } catch (error) {
      return Result.error(new Error("Failed to connect to server.", { cause: error }));
    }

    let exchange: AMQPExchange;

    try {
      exchange = await session.exchange("aw.director.exchange", "topic", { durable: true });
    } catch (error) {
      return Result.error(new Error("Failed to create exchange.", { cause: error }));
    }

    for (const [name, definition] of MessageBroker.#queuesRegistry.entries()) {
      try {
        const queue = await session.queue(name, { durable: true });

        for (const event of definition[0]) {
          await queue.bind(exchange.name, event.typeName);
        }

        definition[1] = new MessageBroker.Queue(queue, [...definition[0]]);
      } catch (error) {
        return Result.error(new Error(`Failed to create or bind queue ${name}.`, { cause: error }));
      }
    }

    this.#logger.info("Message queues initialized", {
      queues: Object.fromEntries(
        MessageBroker.#queuesRegistry.entries().map(([k, v]) => {
          return [k, v[0].map((e) => e.typeName)];
        }),
      ),
    });

    this.#session = session;
    this.#exchange = exchange;

    return Result.ok();
  }

  static #queuesRegistryLocked = false;
  static #queuesRegistry = new Map<string, [readonly Protobuf.MessageDescriptor[], MessageBroker.Queue | null]>();

  static register<T extends readonly [Protobuf.MessageDescriptor, ...Protobuf.MessageDescriptor[]]>(name: string, events: T) {
    if (MessageBroker.#queuesRegistryLocked) {
      throw new Error("Cannot register queue after initialization.");
    }

    if (MessageBroker.#queuesRegistry.has(name)) {
      throw new Error(`Queue for "${name}" is already registered.`);
    }

    MessageBroker.#queuesRegistry.set(name, [events, null]);

    return {
      get value() {
        const val = MessageBroker.#queuesRegistry.get(name)?.[1];

        if (!val) {
          throw new Error(`Queue for "${name}" is not available yet. Did you call init()?`);
        }

        return val as MessageBroker.Queue<T[number]>;
      },
    };
  }
}

export namespace MessageBroker {
  export class Queue<T extends Protobuf.MessageDescriptor = Protobuf.MessageDescriptor> {
    #queue: AMQPQueue;
    #events: T[];

    constructor(queue: AMQPQueue, events: T[]) {
      this.#queue = queue;
      this.#events = events;
    }

    async subscribe(options: QueueSubscribeParams, callback: (envelope: MessageOutbox.Envelope<T>, raw: AMQPMessage) => Promise<void>) {
      await this.#queue.subscribe(options, async (message) => {
        if (message.body === null) {
          throw new Error("Message body is null.");
        }

        const event = this.#events.find((e) => e.typeName === message.routingKey);

        if (!event) {
          throw new Error(`Event ${message.routingKey} is not registered.`);
        }

        const id = message.properties.messageId;

        if (!id) {
          throw new Error("Message ID is missing.");
        }

        const timestamp = message.properties.timestamp;

        if (!timestamp) {
          throw new Error("Message timestamp is missing.");
        }

        const traceId = message.properties.headers?.["x-trace-id"];

        if (traceId && typeof traceId !== "string") {
          throw new Error("Trace ID is not a string.");
        }

        const payload = Protobuf.decode(event, message.body);
        const validated = Protobuf.validate(event, payload);

        if (validated.kind !== "valid") {
          throw new Error(`Message validation failed: ${validated.error}`);
        }

        const envelope = new MessageOutbox.Envelope(event, validated.message, {
          id,
          timestamp,
          traceId: traceId as string | undefined,
        });

        await callback(envelope, message);
      });
    }
  }
}
