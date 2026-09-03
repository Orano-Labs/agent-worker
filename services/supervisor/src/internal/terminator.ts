import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";

export class Terminator {
  get name() {
    return "runtime.Terminator";
  }

  #signal: AbortSignal;
  #terminating: boolean;
  #tasks: Set<Terminator.Task>;

  #logger: Logger;

  constructor(signal: AbortSignal) {
    this.#signal = signal;
    this.#tasks = new Set();
    this.#terminating = false;
    this.#logger = Container.inject(Logger).prefix("Terminator");
  }

  register(task: Terminator.Task) {
    if (this.#terminating) {
      throw new Error("Terminator is already shutting down.");
    }

    this.#tasks.add(task);

    return () => {
      this.#tasks.delete(task);
    };
  }

  get signal() {
    return this.#signal;
  }

  async terminate() {
    if (this.#terminating) {
      throw new Error("Terminator is already shutting down; terminate() was called more than once.");
    }

    this.#terminating = true;

    if (!this.#signal.aborted) {
      await new Promise((resolve) => {
        this.#signal.addEventListener("abort", resolve, { once: true });
      });
    }

    const reason = this.#signal.reason;
    const startedAt = performance.now();

    this.#logger.info("Graceful shutdown started", { reason: String(reason) });

    await Promise.allSettled([...this.#tasks].map((task) => task(reason))).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          this.#logger.error("Terminator task failed:", result.reason);
        }
      }
    });

    const elapsed = performance.now() - startedAt;

    this.#logger.info(`Graceful shutdown finished in ${elapsed.toFixed(0)}ms`);
  }
}

export namespace Terminator {
  export type Task = (reason: unknown) => Promise<void>;
}
