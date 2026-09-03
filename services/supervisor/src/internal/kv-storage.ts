import { join } from "node:path";
import { open } from "lmdb";

import { Container } from "@/helpers/container";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";

const DB_NAME = "kv";

export class KVStorage {
  #db!: ReturnType<typeof open<unknown, string>>;

  #env: Environment;
  #logger: Logger;

  constructor() {
    this.#env = Container.inject(Environment);
    this.#logger = Container.inject(Logger).prefix("KVStorage");
  }

  get db() {
    if (!this.#db) {
      throw new Error("KVStorage database has not been initialized.");
    }

    return this.#db;
  }

  async init() {
    const path = join(this.#env.workdir, DB_NAME);

    try {
      this.#db = open({ path, compression: true });
    } catch (error) {
      this.#logger.errorFrom(error, "Failed to open kv storage database");

      process.exit(1);
    }
  }
}
