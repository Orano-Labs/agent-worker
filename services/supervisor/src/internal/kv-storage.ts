import { join } from "node:path";
import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { open } from "lmdb";

const DB_NAME = "kv";

export class KVStorage extends Container.ServiceConstructable {
  #db?: ReturnType<typeof open<unknown, string>>;

  #environment: Environment;
  #logger: Logger;

  constructor(...deps: [Logger, Environment]) {
    super();

    this.#environment = deps[1];
    this.#logger = deps[0].namespace("KVStorage");
  }

  get db() {
    if (!this.#db) {
      throw new Error("KVStorage database has not been initialized.");
    }

    return this.#db;
  }

  protected override async initialize() {
    this.#db = open({ path: join(this.#environment.root, DB_NAME), compression: true });
  }

  protected override async dispose(reason?: unknown) {
    if (this.#db) {
      await this.#db.close();
    }

    this.#db = undefined;
  }
}
