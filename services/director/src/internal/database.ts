import { stat } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
      throw new Error("Database client is not available");
    }

    return this.#client;
  }

  get schema() {
    return schema;
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
      const message = "AW_DIRECTOR_MYSQL_URL is not set, cannot initialize database";

      this.#logger.error(message);
      this.#status = { type: "error", message };

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
      this.#logger.info("Migrating database...");
      await migrate(this.#client, { migrationsFolder: dir });
    } catch (error) {
      this.#logger.errorFrom(error, "Failed to migrate database");

      this.#status = {
        type: "error",
        message: "Failed to migrate database",
      };

      return;
    }

    try {
      const existing = await this.#client.select().from(schema.USERS_TABLE).where(eq(schema.USERS_TABLE.role, "admin")).limit(1);

      if (existing.length === 0) {
        this.#logger.info("Creating seed admin user...");

        const [result] = await this.#client.insert(schema.USERS_TABLE).values({
          role: "admin",
        });

        const [row] = await this.#client
          .select({
            uid: schema.USERS_TABLE.uid,
          })
          .from(schema.USERS_TABLE)
          .where(eq(schema.USERS_TABLE.id, result.insertId));

        this.#logger.info("Seed admin user created successfully", {
          user: {
            uid: this.uuidFromBuffer(row.uid),
          },
        });
      }
    } catch (error) {
      this.#logger.errorFrom(error, "Failed to create seed user");

      this.#status = {
        type: "error",
        message: "Failed to create seed user",
      };

      return;
    }

    this.#status = {
      type: "ready",
    };

    this.#logger.info("Initialization completed");
  }

  // Converts UUID string to Buffer, compatible with MySQL's UUID_TO_BIN(uuid, 1).
  // MySQL's UUID_TO_BIN with swap_flag=1 reorders the timestamp parts for better index performance.
  // This method replicates that behavior by rearranging UUID segments.
  uuidToBuffer(uuid: string) {
    const hex = uuid.replace(/-/g, "").toLowerCase();

    const data0 = hex.substring(12, 16);
    const data1 = hex.substring(8, 12);
    const data2 = hex.substring(0, 8);
    const data3 = hex.substring(16, 20);
    const data4 = hex.substring(20, 32);

    return Buffer.from(`${data0}${data1}${data2}${data3}${data4}`, "hex");
  }

  // Converts Buffer back to UUID string, reversing the MySQL UUID_TO_BIN(uuid, 1) transformation.
  // Restores the original UUID format from the reordered binary representation.
  uuidFromBuffer(buffer: Buffer) {
    const hex = buffer.toString("hex");

    const data3 = hex.substring(0, 4);
    const data2 = hex.substring(4, 8);
    const data1 = hex.substring(8, 16);
    const data4 = hex.substring(16, 20);
    const data5 = hex.substring(20, 32);

    return `${data1}-${data2}-${data3}-${data4}-${data5}`;
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
