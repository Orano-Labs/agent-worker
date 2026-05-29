import { join } from "node:path";
import { open } from "lmdb";

import { Container } from "@/helpers/container";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

const HEAD_KEY = "queue_head_idx"; // 指向队列头部（消费端）
const TAIL_KEY = "queue_tail_idx"; // 指向队列尾部（生产端）

const DB_NAME = ".event-queue";

export class EventQueue {
  #db!: ReturnType<typeof open<EventQueue.Event, string>>;

  #env: Environment;
  #logger: Logger;
  #variables: Variables;

  constructor() {
    this.#env = Container.inject(Environment);
    this.#logger = Container.inject(Logger).scope("EventQueue");
    this.#variables = Container.inject(Variables);
  }

  get db() {
    return this.#db;
  }

  async enqueue(event: EventQueue.Event): Promise<void> {
    if (!this.#db) {
      throw new Error("EventQueue is not initialized");
    }

    await this.#db.transaction(async () => {
      const tail = (this.#db.get(TAIL_KEY) as EventQueue.Event<number>) || {
        type: "",
        patload: 0,
      };

      await this.#db.put(`msg_${tail.patload}`, event);
      await this.#db.put(TAIL_KEY, { ...tail, patload: tail.patload + 1 });
    });
  }

  async dequeue(): Promise<EventQueue.Event | null> {
    if (!this.#db) {
      throw new Error("EventQueue is not initialized");
    }

    let result: EventQueue.Event | null = null;

    await this.#db.transaction(async () => {
      const tail = (this.#db.get(TAIL_KEY) as EventQueue.Event<number>) || {
        type: "",
        patload: 0,
      };
      const head = (this.#db.get(HEAD_KEY) as EventQueue.Event<number>) || {
        type: "",
        patload: 0,
      };

      if (head.patload >= tail.patload) {
        return;
      }

      const msgKey = `msg_${head.patload}`;

      result = this.#db.get(msgKey) || null;

      await this.#db.remove(msgKey);
      await this.#db.put(HEAD_KEY, { ...head, patload: head.patload + 1 });
    });

    return result;
  }

  async init() {
    this.#logger.info("Initializing...");

    const path = join(this.#env.workdir, DB_NAME);

    try {
      this.#db = open({ path, compression: true });
    } catch (error) {
      this.#logger.errorFrom(error, "Failed to open local event queue database");

      process.exit(1);
    }

    this.#logger.info("Initialization completed");
  }
}

export namespace EventQueue {
  export type Event<P = any, T extends string = string> = {
    type: T;
    patload: P;
  };
}
