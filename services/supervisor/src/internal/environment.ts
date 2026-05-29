import { mkdir } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";

import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

declare const VERSION: string;

export class Environment {
  #logger: Logger;
  #cli: CommandLine;
  #variables: Variables;

  get platform() {
    return platform();
  }

  get arch() {
    return arch();
  }

  get workdir() {
    return this.#variables.get("AW_SUPERVISOR_ROOT_DIR") || join(homedir(), ".aw-supervisor");
  }

  get version() {
    return VERSION;
  }

  get cwd() {
    return this.#cli.cwd;
  }

  constructor() {
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

        return process.exit(1);
      }
    }

    this.#logger.info("Initialization completed");
  }
}
