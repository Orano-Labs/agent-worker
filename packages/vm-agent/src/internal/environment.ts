import { exec } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";

declare const VERSION: string;

export class Environment {
  #status: Environment.Status;
  #logger: Logger;

  get platform() {
    return platform();
  }

  get arch() {
    return arch();
  }

  get ready() {
    return this.#status.type === "ready";
  }

  get workdir() {
    return join(homedir(), ".agent-worker");
  }

  get status() {
    return this.#status;
  }

  get version() {
    return VERSION;
  }

  constructor() {
    this.#status = {
      type: "error",
      message: "Not initialized",
    };

    this.#logger = Container.inject(Logger).scope("Environment");
  }

  async init() {
    this.#logger.info("Initializing...");

    try {
      await mkdir(this.workdir, { recursive: true });
    } catch (error) {
      this.#logger.errorFrom(error, "Failed to create workdir");

      this.#status = {
        type: "error",
        message: "Failed to create workdir",
      };

      return;
    }

    try {
      await promisify(exec)("git --version").then((o) => {
        if (!o.stdout.startsWith("git version")) {
          throw new Error(`Invalid git version output: ${o.stdout}`);
        }
      });
    } catch (error) {
      this.#logger.errorFrom(error, "Failed to verify git installation");

      this.#status = {
        type: "error",
        message: "Failed to verify git installation",
      };

      return;
    }

    this.#status = {
      type: "ready",
    };

    this.#logger.info("Initialized");
  }

  async reset() {
    await rm(this.workdir, { force: true, recursive: true });
  }
}

export namespace Environment {
  export type Status =
    | {
        type: "ready";
      }
    | {
        type: "error";
        message: string;
      };
}
