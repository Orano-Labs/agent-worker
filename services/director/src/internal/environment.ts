import { mkdir } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";

import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

declare const VERSION: string;

export class Environment {
  #status: Environment.Status;
  #logger: Logger;
  #cli: CommandLine;
  #variables: Variables;

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
    return this.#variables.get("AW_DIRECTOR_ROOT_DIR") || join(homedir(), ".aw-director");
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
    this.#variables = Container.inject(Variables);
  }

  async init() {
    this.#logger.info("Initializing...", {
      workdir: this.workdir,
      platform: this.platform,
      arch: this.arch,
      cwd: this.cwd,
    });

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

    this.#status = {
      type: "ready",
    };

    this.#logger.info("Initialization completed");
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
