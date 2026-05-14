import { stat } from "node:fs/promises";
import { join } from "node:path";
import { default as SQLite } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { Container } from "@/helpers/container";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";
import { schema } from "@/supports/database/schema";

export class Database {
  #driver: SQLite.Database;
  #client: BetterSQLite3Database<typeof schema>;

  #env: Environment;
  #logger: Logger;

  #status: Database.Status;

  constructor() {
    this.#driver = new SQLite(":memory:");
    this.#client = drizzle(this.#driver);

    this.#status = {
      type: "error",
      message: "Not initialized",
    };

    this.#env = Container.inject(Environment);
    this.#logger = Container.inject(Logger).scope("Database");
  }

  get status() {
    return this.#status;
  }

  get ready() {
    return this.#status.type === "ready";
  }

  get client() {
    return this.#client;
  }

  get schema() {
    return schema;
  }

  getUnixTimestamp() {
    return Math.floor(Date.now() / 1000);
  }

  async init() {
    this.#logger.info("Initializing...");

    if (!this.#env.ready) {
      this.#logger.error("Environment not ready, cannot initialize database");

      this.#status = {
        type: "error",
        message: "Environment not ready, cannot initialize database",
      };

      return;
    }

    try {
      this.#driver = new SQLite(join(this.#env.workdir, "data/database.db"));
      this.#client = drizzle(this.#driver);
    } catch (error) {
      this.#logger.errorFrom(error, "Failed to initialize database");

      this.#status = {
        type: "error",
        message: "Failed to initialize database",
      };

      return;
    }

    const dir = join(this.#env.cwd, "drizzle/migrations");

    try {
      await stat(dir);
    } catch (error) {
      this.#logger.errorFrom(error, `Migrations directory ${dir} does not exist`);

      this.#status = {
        type: "error",
        message: `Migrations directory ${dir} does not exist`,
      };

      return;
    }

    try {
      migrate(this.#client, { migrationsFolder: dir });
    } catch (error) {
      this.#logger.errorFrom(error, "Failed to migrate database");

      this.#status = {
        type: "error",
        message: "Failed to migrate database",
      };

      return;
    }

    this.#status = {
      type: "ready",
    };
  }
}

export namespace Database {
  export type Status =
    | {
        type: "ready";
      }
    | {
        type: "error";
        message: string;
      };
}
