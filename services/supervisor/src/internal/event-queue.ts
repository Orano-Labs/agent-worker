import { Container } from "@/helpers/container";
import { Environment } from "@/internal/environment";
import { KVStorage } from "@/internal/kv-storage";
import { Logger } from "@/internal/logger";

const HEAD_KEY = "queue_head_idx"; // 指向队列头部（消费端）
const TAIL_KEY = "queue_tail_idx"; // 指向队列尾部（生产端）

export class EventQueue {
  #kv: KVStorage;
  #env: Environment;
  #logger: Logger;

  constructor() {
    this.#env = Container.inject(Environment);
    this.#logger = Container.inject(Logger).scope("EventQueue");
    this.#kv = Container.inject(KVStorage);
  }

  #getHead() {
    const value = this.#kv.db.get(HEAD_KEY);

    if (typeof value !== "number") {
      return 0;
    }

    return value;
  }

  #getTail() {
    const value = this.#kv.db.get(TAIL_KEY);

    if (typeof value !== "number") {
      return 0;
    }

    return value;
  }

  get pending() {
    const tail = this.#getTail();
    const head = this.#getHead();

    if (head >= tail) {
      return 0;
    }

    return tail - head;
  }

  async enqueue(event: unknown): Promise<void> {
    await this.#kv.db.transaction(async () => {
      const tail = this.#getTail();

      this.#kv.db.put(`event_queue_${tail}`, event);
      this.#kv.db.put(TAIL_KEY, tail + 1);
    });
  }

  async dequeue(callback: (event: unknown) => Promise<void> | void) {
    return await this.#kv.db.transaction(async () => {
      const tail = this.#getTail();
      const head = this.#getHead();

      if (head >= tail) {
        return false;
      }

      const event = this.#kv.db.get(`event_queue_${head}`);

      await callback(event);

      this.#kv.db.remove(`event_queue_${head}`);
      this.#kv.db.put(HEAD_KEY, head + 1);

      return true;
    });
  }

  async init() {}
}
