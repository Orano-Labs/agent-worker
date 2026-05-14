import { exec } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Logger } from "@/internal/logger";

declare const VERSION: string;

export class Environment {
  #status: Environment.Status;
  #logger: Logger;
  #cli: CommandLine;

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

  get cwd() {
    return this.#cli.cwd;
  }

  constructor() {
    this.#status = {
      type: "error",
      message: "Not initialized",
    };

    this.#logger = Container.inject(Logger).scope("Environment");
    this.#cli = Container.inject(CommandLine);
  }

  async init() {
    this.#logger.info("Initializing...");

    const directories = [
      {
        path: this.workdir,
        description: "work",
      },
      {
        path: join(this.workdir, "data"),
        description: "data",
      },
    ];

    for (const directory of directories) {
      try {
        await mkdir(directory.path, { recursive: true });
      } catch (error) {
        this.#logger.errorFrom(error, `Failed to create ${directory.description} directory`);

        this.#status = {
          type: "error",
          message: `Failed to create ${directory.description} directory`,
        };

        return;
      }
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
