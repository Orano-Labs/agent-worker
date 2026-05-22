import { exec } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { lock } from "proper-lockfile";

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
    return this.#variables.get("VM_AGENT_ROOT_DIR") || join(homedir(), ".agent-worker");
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

    try {
      await promisify(exec)("git --version").then((o) => {
        if (!o.stdout.startsWith("git version")) {
          throw new Error(`Invalid git version output: ${o.stdout}`);
        }

        this.#logger.info(`Git version: ${o.stdout.replace("git version", "").trim()}`);
      });
    } catch (error) {
      this.#logger.errorFrom(error, "Failed to verify git installation");

      this.#status = {
        type: "error",
        message: "Failed to verify git installation",
      };

      return;
    }

    try {
      await promisify(exec)("claude --version").then((o) => {
        this.#logger.info(`Claude version: ${o.stdout.split(" ")[0].trim()}`);
      });
    } catch (error) {
      this.#logger.errorFrom(error, "Failed to verify claude installation");

      this.#status = {
        type: "error",
        message: "Failed to verify claude installation",
      };

      return;
    }

    try {
      const release = await lock(join(this.workdir, ".single-instance-lock"), {
        realpath: false,
      });

      const exit = async () => {
        this.#logger.info("Received termination signal, releasing lock...");

        await release().catch((error) => {
          this.#logger.errorFrom(error, "Failed to release single instance lock");
        });
      };

      process.on("SIGINT", exit);
      process.on("SIGTERM", exit);
    } catch (error) {
      this.#logger.errorFrom(error, "Failed to acquire single instance lock");

      this.#status = {
        type: "error",
        message: "Failed to acquire single instance lock",
      };

      return;
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
