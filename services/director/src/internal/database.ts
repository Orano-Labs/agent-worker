import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createPool, Pool } from "mysql2/promise";

import { InstanceTable, ProjectTable, SupervisorTable, TemplateTable, UserTable } from "@/internal/database-schema";

const DATABASE_TABLES = {
  user: UserTable,
  project: ProjectTable,
  supervisor: SupervisorTable,
  instance: InstanceTable,
  template: TemplateTable,
} as const;

const DATABASE_RELATIONS = defineRelations(DATABASE_TABLES, (r) => ({
  user: {
    projects: r.many.project({
      from: [r.user.id],
      to: [r.project.ownerId],
    }),
    supervisors: r.many.supervisor({
      from: [r.user.id],
      to: [r.supervisor.ownerId],
    }),
  },
  project: {
    owner: r.one.user({
      from: [r.project.ownerId],
      to: [r.user.id],
      optional: false,
    }),
    template: r.one.template({
      from: [r.project.templateId],
      to: [r.template.id],
      optional: true,
    }),
    supervisor: r.one.supervisor({
      from: [r.project.supervisorId],
      to: [r.supervisor.id],
      optional: true,
    }),
    instance: r.one.instance({
      from: [r.project.id],
      to: [r.instance.projectId],
      optional: true,
    }),
  },
  supervisor: {
    owner: r.one.user({
      from: [r.supervisor.ownerId],
      to: [r.user.id],
      optional: true,
    }),
    instances: r.many.instance({
      from: [r.supervisor.id],
      to: [r.instance.supervisorId],
    }),
    projects: r.many.project({
      from: [r.supervisor.id],
      to: [r.project.supervisorId],
    }),
  },
  instance: {
    project: r.one.project({
      from: [r.instance.projectId],
      to: [r.project.id],
      optional: false,
    }),
    supervisor: r.one.supervisor({
      from: [r.instance.supervisorId],
      to: [r.supervisor.id],
      optional: false,
    }),
  },
  template: {
    sourceTemplate: r.one.template({
      from: [r.template.sourceTemplateId],
      to: [r.template.id],
      optional: true,
    }),
    forks: r.many.template({
      from: [r.template.id],
      to: [r.template.sourceTemplateId],
    }),
    projects: r.many.project({
      from: [r.template.id],
      to: [r.project.templateId],
    }),
  },
}));

export class Database extends Container.ServiceConstructable {
  #environment: Environment;
  #logger: Logger;

  #pool?: Pool;
  #client?: ReturnType<typeof drizzle<typeof DATABASE_RELATIONS>>;

  constructor(...deps: [Environment, Logger]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("Database");
  }

  get pool() {
    if (!this.#pool) {
      throw new Error("Database pool is not initialized.");
    }

    return this.#pool;
  }

  get client() {
    if (!this.#client) {
      throw new Error("Database client is not initialized.");
    }

    return this.#client;
  }

  protected override async initialize(signal: AbortSignal) {
    const connectionString = this.#environment.get("DATABASE_URL", true);
    const migrationsFolder = this.#environment.get("DATABASE_MIGRATIONS", true);

    if (signal.aborted) {
      throw new Error("Database initialization aborted.", { cause: signal.reason });
    }

    const pool = createPool(connectionString);

    pool.on("connection", (connection) => {
      connection.on("error", (error) => {
        this.#logger.error("Unexpected MySQL connection error.", { error });
      });
    });

    try {
      const connection = await pool.getConnection();

      try {
        await connection.ping();
      } finally {
        // The probe connection must be returned to the pool, otherwise it is
        // checked out forever and `pool.end()` hangs / connections leak.
        connection.release();
      }
    } catch (error) {
      await pool.end();

      throw new Error("Failed to connect to the database.", { cause: error });
    }

    const client = drizzle({
      client: pool,
      relations: DATABASE_RELATIONS,
    });

    try {
      if (signal.aborted) {
        throw new Error("Database initialization aborted.", { cause: signal.reason });
      }

      this.#logger.info("Running database migrations.", { migrationsFolder });

      await migrate(client, { migrationsFolder });
    } catch (error) {
      await pool.end();

      throw new Error("Failed to run database migrations.", { cause: error });
    }

    this.#pool = pool;
    this.#client = client;

    this.#logger.info("Database pool connected and migrations completed successfully.");
  }

  protected override async dispose() {
    const pool = this.#pool;

    if (pool === undefined) {
      return;
    }

    this.#pool = undefined;
    this.#client = undefined;

    try {
      await pool.end();
      this.#logger.info("Database pool closed gracefully.");
    } catch (error) {
      this.#logger.error("Failed to close the database pool during shutdown.", { error });
    }
  }
}
