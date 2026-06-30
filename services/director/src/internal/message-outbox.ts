import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";

export class MessageOutbox {
  #logger: Logger;
  #repository: Repository;
  #subscribers: Set<() => void>;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Outbox");
    this.#repository = Container.inject(Repository);
    this.#subscribers = new Set();
  }

  subscribe(subscriber: () => void) {
    this.#subscribers.add(subscriber);

    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  async write(envelope: MessageOutbox.Envelope, context: Repository.TxContext) {
    await context.client.outbox.create({
      data: {
        id: envelope.id,
        createTime: envelope.timestamp,
        topic: envelope.topic,
        payload: Protobuf.encode(envelope.descriptor, envelope.payload),
      },
    });

    context.hooks.on("commit", () => {
      for (const subscriber of this.#subscribers) {
        try {
          subscriber();
        } catch (error) {
          this.#logger.errorFrom(error, "Error in event committed subscriber");
        }
      }
    });
  }

  async read() {
    const rows = await this.#repository.client.outbox.findMany({
      where: {
        publishTime: null,
      },
      orderBy: {
        createTime: "asc",
      },
      take: 50,
    });

    return rows.map((row) => {
      const record: MessageOutbox.Record = {
        id: row.id,
        timestamp: row.createTime,
        topic: row.topic,
        payload: row.payload,
      };

      return record;
    });
  }

  async published(records: [id: string, timestamp: Date][]) {
    await this.#repository.client.$transaction(
      records.map(([id, timestamp]) => {
        return this.#repository.client.outbox.update({ where: { id, publishTime: null }, data: { publishTime: timestamp } });
      }),
    );
  }

  static envelope<T extends Protobuf.MessageDescriptor>(
    desc: T,
    message: Protobuf.MessageValid<T>,
    options?: Partial<MessageOutbox.Envelope.Options>,
  ) {
    return new MessageOutbox.Envelope(desc, message, {
      id: options?.id || crypto.randomUUID(),
      timestamp: options?.timestamp || new Date(),
    });
  }
}

export namespace MessageOutbox {
  export class Envelope<T extends Protobuf.MessageDescriptor = Protobuf.MessageDescriptor> {
    #descriptor: T;
    #payload: Protobuf.MessageValid<T>;

    #id: string;
    #timestamp: Date;

    constructor(descriptor: T, payload: Protobuf.MessageValid<T>, options: Envelope.Options) {
      if (!Protobuf.events.getMessage(descriptor.typeName)) {
        throw new Error(`Unknown event topic: ${descriptor.typeName}`);
      }

      // @ts-expect-error
      const result = Protobuf.validator.validate(descriptor, payload);

      if (result.kind !== "valid") {
        throw result.error;
      }

      this.#descriptor = descriptor;
      this.#payload = result.message;

      this.#id = options.id;
      this.#timestamp = options.timestamp;
    }

    get topic() {
      return this.#descriptor.typeName;
    }

    get payload() {
      return this.#payload;
    }

    get id() {
      return this.#id;
    }

    get timestamp() {
      return this.#timestamp;
    }

    get descriptor() {
      return this.#descriptor;
    }
  }

  export namespace Envelope {
    export type Options = {
      id: string;
      timestamp: Date;
    };
  }

  export type Record = {
    id: string;
    timestamp: Date;
    topic: string;
    payload: Uint8Array;
  };
}
