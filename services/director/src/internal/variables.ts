import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

import { Container } from "@/helpers/container";
import { Result } from "@/helpers/result";
import { CommandLine } from "@/internal/command-line";
import { Key } from "@/internal/key";
import { Logger } from "@/internal/logger";

export class Variables {
  #cli: CommandLine;
  #logger: Logger;
  #env: NodeJS.Dict<string>;
  #key: Key;

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
    this.#key = Container.inject(Key);
  }

  async init(): Promise<Result<void, Error>> {
    if (this.#cli.envFiles.length > 0) {
      for (const file of this.#cli.envFiles) {
        let content: string;

        try {
          content = await readFile(file, "utf-8");
        } catch (error) {
          return Result.error(new Error(`Failed to read environment file: ${file}`, { cause: error }));
        }

        let parsed: NodeJS.Dict<string>;

        try {
          parsed = parseEnv(content);
        } catch (error) {
          return Result.error(new Error(`Failed to parse environment file: ${file}`, { cause: error }));
        }

        for (const [key, value] of Object.entries(parsed)) {
          if (value === undefined) {
            continue;
          }

          // @ts-expect-error
          if (!Variables.TRUSTED.includes(key)) {
            continue;
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

    const variables = {
      HTTP_PORT: this.get("AW_DIRECTOR_HTTP_PORT") || null,
      HTTP_HOST: this.get("AW_DIRECTOR_HTTP_HOST") || null,
      MYSQL_URL: this.get("AW_DIRECTOR_MYSQL_URL") || null,
      MANAGER_PUBLIC_KEY: this.get("AW_DIRECTOR_MANAGER_PUBLIC_KEY") || null,
      GRPC_CA_KEY: this.get("AW_DIRECTOR_GRPC_CA_KEY") || null,
      GRPC_CA_CERTIFICATE: this.get("AW_DIRECTOR_GRPC_CA_CERTIFICATE") || null,
    };

    if (variables.MYSQL_URL) {
      variables.MYSQL_URL = this.#logger.mask(variables.MYSQL_URL);
    }

    if (!variables.MANAGER_PUBLIC_KEY) {
      const keys = await this.#key.generateED25519();
      const publicKey = keys[0].toString("hex");
      const privateKey = keys[1].toString("hex");

      this.#env.AW_DIRECTOR_MANAGER_PUBLIC_KEY = publicKey;

      this.#logger.warn("Generated new manager key pair. Keys logged for initial setup only.", {
        PRIVATE: privateKey,
        PUBLIC: publicKey,
      });
    }

    this.#logger.info("Loaded environment variables", {
      env: variables,
    });

    return Result.ok();
  }

  get(key: (typeof Variables.TRUSTED)[number]) {
    return this.#env[key];
  }

  getBoolean(key: (typeof Variables.TRUSTED)[number]): boolean {
    const value = this.get(key)?.toLowerCase().trim();

    return value === "true" || value === "1" || value === "yes";
  }

  getNumber(key: (typeof Variables.TRUSTED)[number], fallback: number): number;
  getNumber(key: (typeof Variables.TRUSTED)[number]): number | undefined;
  getNumber(key: (typeof Variables.TRUSTED)[number], fallback?: number): number | undefined {
    const value = this.get(key);

    if (value === undefined) {
      return fallback;
    }

    const parsed = Number(value);

    return Number.isNaN(parsed) ? fallback : parsed;
  }
}

export namespace Variables {
  export const TRUSTED_PREFIX = "AW_DIRECTOR_";

  export const TRUSTED = [
    `${TRUSTED_PREFIX}ROOT_DIR`,
    `${TRUSTED_PREFIX}HTTP_PORT`,
    `${TRUSTED_PREFIX}HTTP_HOST`,

    `${TRUSTED_PREFIX}MYSQL_URL`,

    `${TRUSTED_PREFIX}MANAGER_PUBLIC_KEY`,
    `${TRUSTED_PREFIX}MANAGER_PRIVATE_KEY`,

    `${TRUSTED_PREFIX}GRPC_CA_KEY`,
    `${TRUSTED_PREFIX}GRPC_CA_CERTIFICATE`,

    `${TRUSTED_PREFIX}MQ_URL`,

    `${TRUSTED_PREFIX}REDIS_URL`,
    `${TRUSTED_PREFIX}FS_ROOT`,
  ] as const;
}
