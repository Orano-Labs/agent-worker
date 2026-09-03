import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";

export class Terminator {
  #signal?: string;
  #done: boolean;
  #tasks: Set<Terminator.Task>;
  #inflight: Set<Promise<void>>;
  #shutdown?: Promise<void>;

  #logger: Logger;

  constructor() {
    this.#tasks = new Set();
    this.#logger = Container.inject(Logger).prefix("Terminator");
    this.#inflight = new Set();
    this.#done = false;
  }

  register(task: Terminator.Task) {
    if (this.#done) {
      throw new Error("Shutdown has already completed. Cannot register new tasks.");
    }

    if (this.#signal) {
      return this.#execute(task, this.#signal);
    }

    this.#tasks.add(task);
  }

  async terminate(signal: string) {
    if (!this.#shutdown) {
      this.#shutdown = this.#doTerminate(signal);
    }

    return this.#shutdown;
  }

  #execute(task: Terminator.Task, signal: string) {
    const promise = task(signal)
      .catch((err) => {
        this.#logger.error("Terminator task failed:", err);
      })
      .finally(() => {
        this.#inflight.delete(promise);
      });

    this.#inflight.add(promise);
  }

  async #doTerminate(signal: string) {
    this.#signal = signal;

    const startedAt = performance.now();

    this.#logger.info("Graceful shutdown started", { signal });

    for (const task of this.#tasks) {
      this.#execute(task, signal);
    }

    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight]);
    }

    const elapsed = performance.now() - startedAt;

    this.#logger.info(`Graceful shutdown finished in ${elapsed.toFixed(0)}ms`);

    this.#done = true;
  }
}

export namespace Terminator {
  export type Task = (signal: string) => Promise<void>;
}
