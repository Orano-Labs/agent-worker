import { stat } from "node:fs/promises";
import { join } from "node:path";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";

import { Container } from "@/helpers/container";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";
import { schema } from "@/supports/database/schema";

export class Database {
  #client?: MySql2Database<typeof schema>;

  #env: Environment;
  #logger: Logger;
  #variables: Variables;

  #status: Database.Status;

  constructor() {
    this.#status = {
      type: "error",
      message: "Not initialized",
    };

    this.#env = Container.inject(Environment);
    this.#logger = Container.inject(Logger).scope("Database");
    this.#variables = Container.inject(Variables);
  }

  get status() {
    return this.#status;
  }

  get ready() {
    return this.#status.type === "ready";
  }

  get client() {
    if (!this.#client) {
      throw new Error("xx");
    }

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

    const url = this.#variables.get("AW_DIRECTOR_MYSQL_URL");

    if (!url) {
      this.#logger.error("Environment not ready, cannot initialize database");

      this.#status = {
        type: "error",
        message: "Environment not ready, cannot initialize database",
      };

      return;
    }

    try {
      this.#client = drizzle(url);
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
      await migrate(this.#client, { migrationsFolder: dir });
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

    this.#logger.info("Initialization completed");
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
