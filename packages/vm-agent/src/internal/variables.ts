import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Logger } from "@/internal/logger";

export class Variables {
  #cli: CommandLine;
  #logger: Logger;
  #env: NodeJS.Dict<string>;

  constructor() {
    this.#env = {};

    for (const [key, value] of Object.entries(process.env)) {
      // @ts-expect-error
      if (Variables.TRUSTED.includes(key)) {
        this.#env[key] = value;
      }
    }

    this.#cli = Container.inject(CommandLine);
    this.#logger = Container.inject(Logger).scope("Variables");
  }

  async init() {
    this.#logger.info("Initializing...");

    if (this.#cli.envFiles.length > 0) {
      for (const file of this.#cli.envFiles) {
        let content: string;

        try {
          content = await readFile(file, "utf-8");
        } catch (error) {
          return this.#logger.errorFrom(error, `Failed to read environment file: ${file}`);
        }

        let parsed: NodeJS.Dict<string>;

        try {
          parsed = parseEnv(content);
        } catch (error) {
          return this.#logger.errorFrom(error, `Failed to parse environment file: ${file}`);
        }

        for (const [key, value] of Object.entries(parsed)) {
          if (value === undefined) {
            break;
          }

          // @ts-expect-error
          if (!Variables.TRUSTED.includes(key)) {
            this.#logger.warn(`Skipping untrusted environment variable ${key} from ${file}`);
            break;
          }

          if (this.#env[key] !== undefined) {
            this.#logger.debug(`Environment variable ${key} already exists, overwriting with value from ${file}`);
          } else {
            this.#logger.debug(`Loaded new environment variable ${key} from ${file}`);
          }

          this.#env[key] = value;
        }
      }
    } else {
      this.#logger.info("No environment files found");
    }

    this.#logger.info("Initialization completed");
  }

  get(key: (typeof Variables.TRUSTED)[number]) {
    return this.#env[key];
  }
}

export namespace Variables {
  export const TRUSTED_PREFIX = "VM_AGENT_";

  export const TRUSTED = [
    // REGISTRY
    `${TRUSTED_PREFIX}REGISTRY_KEY`,
    `${TRUSTED_PREFIX}REGISTRY_URL`,
  ] as const;
}
