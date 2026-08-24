import { mkdir } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";

import { Container } from "@/helpers/container";
import { Result } from "@/helpers/result";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

declare const VERSION: string;

export class Environment {
  #logger: Logger;
  #variables: Variables;

  get platform() {
    return platform();
  }

  get arch() {
    return arch();
  }

  get workdir() {
    return this.#variables.get("AW_DIRECTOR_ROOT_DIR") || join(homedir(), ".aw-director");
  }

  get version() {
    return VERSION;
  }

  get cwd() {
    return process.cwd();
  }

  constructor() {
    this.#logger = Container.inject(Logger).scope("Environment");
    this.#variables = Container.inject(Variables);
  }

  async init(): Promise<Result<void, Error>> {
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
        return Result.error(new Error(`Failed to create ${directory.description} directory`, { cause: error }));
      }
    }

    this.#logger.info("Initialization completed", {
      workdir: this.workdir,
      cwd: this.cwd,
    });

    return Result.ok();
  }
}
