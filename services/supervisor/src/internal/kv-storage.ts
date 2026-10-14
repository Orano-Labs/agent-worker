import { join } from "node:path";
import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import { open } from "lmdb";

const DB_NAME = "kv";

export class KVStorage extends Container.ServiceConstructable {
  #db?: ReturnType<typeof open<unknown, string>>;

  #environment: Environment;

  constructor(...deps: [Environment]) {
    super();

    this.#environment = deps[0];
  }

  get db() {
    if (!this.#db) {
      throw new Error("KVStorage database has not been initialized.");
    }

    return this.#db;
  }

  protected override async initialize() {
    this.#db = open({
      path: join(this.#environment.root, DB_NAME),
      compression: true,
    });
  }

  protected override async dispose(_?: unknown) {
    if (this.#db) {
      await this.#db.close();
    }

    this.#db = undefined;
  }
}
