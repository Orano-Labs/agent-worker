import { homedir } from "node:os";
import { join } from "node:path";
import { VMController } from "@aw/vm-manager";
import { asError } from "catch-unknown";
import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";

declare const VERSION: string;

export class Environment {
  #status: Environment.Status;
  #logger: Logger;
  #controller: VMController;

  get ready() {
    return this.#status.type === "ready";
  }

  get status() {
    return this.#status;
  }

  get version() {
    return VERSION;
  }

  get controller() {
    return this.#controller;
  }

  constructor() {
    this.#status = {
      type: "idle",
    };

    this.#logger = Container.inject(Logger).scope("Environment");
    this.#controller = new VMController({
      root: join(homedir(), ".aw-vms"),
    });
  }

  init() {
    if (this.#status.type !== "idle") {
      return this.#logger.warn("xxx ");
    }

    this.#logger.info("Initilizing ...");

    this.#status = {
      type: "initializing",
    };

    const updateInitializingDetails = (details: string) => {
      if (this.#status.type === "initializing") {
        this.#status.details = details;
      }
    };

    (async () => {
      this.#logger.info("Initializing vm controller ...");

      await this.#controller.init();

      this.#logger.info("Initialized vm controller");
    })()
      .then(() => {
        this.#status = { type: "ready" };
      })
      .catch((error) => {
        this.#status = { type: "error", message: asError(error).message };
      });
  }
}

export namespace Environment {
  export type Status =
    | {
        type: "ready" | "idle";
      }
    | {
        type: "error";
        message: string;
      }
    | {
        type: "initializing";
        details?: string;
      };
}

Container.singleton(Environment, () => new Environment());
