import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createDB } from "mysql-memory-server";
import { createConnection } from "mysql2/promise";
import { RedisMemoryServer } from "redis-memory-server";
import { Database } from "@/internal/database";
import { Redis } from "@/internal/redis";

export namespace TestingUtils {
  type SharedDatabase = {
    server: Awaited<ReturnType<typeof createDB>>;
    admin: Awaited<ReturnType<typeof createConnection>>;
    randomDatabase: () => Promise<string>;
  };

  export class MemoryDatabase extends Database {
    #database?: string;

    override async initialize(signal: AbortSignal) {
      const shared = await MemoryDatabase.#shared();
      const database = await shared.randomDatabase();

      this.#database = database;

      process.env.DATABASE_URL = `mysql://${encodeURIComponent(shared.server.username)}@127.0.0.1:${shared.server.port}/${database}`;
      process.env.DATABASE_MIGRATIONS ??= join(process.cwd(), "drizzle/migrations");

      try {
        await super.initialize(signal);
      } catch (error) {
        this.#database = undefined;

        await shared.admin.query(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => {});

        throw error;
      }
    }

    override async dispose() {
      const database = this.#database;

      this.#database = undefined;

      await super.dispose();

      if (database === undefined) {
        return;
      }

      const shared = await MemoryDatabase.#shared();

      await shared.admin.query(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => {});
    }

    static async warmup() {
      return MemoryDatabase.#shared();
    }

    static async stop() {
      const shared = MemoryDatabase.#sharedCache;

      MemoryDatabase.#sharedCache = undefined;

      if (!shared) {
        return;
      }

      const resolved = await shared;

      try {
        await resolved.admin.end();
      } finally {
        await resolved.server.stop();
      }
    }

    static #sharedCache?: Promise<SharedDatabase>;

    static #shared() {
      if (!MemoryDatabase.#sharedCache) {
        MemoryDatabase.#sharedCache = (async () => {
          const server = await createDB({
            version: "9.7.2",
            dbName: "aw_test",
            logLevel: "ERROR",
            xEnabled: "OFF",
          });

          const admin = await createConnection({
            host: "127.0.0.1",
            port: server.port,
            user: server.username,
            password: "",
            database: server.dbName,
          });

          return {
            server,
            admin,
            randomDatabase: async () => {
              const database = `test_${randomBytes(8).toString("hex")}`;

              await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

              return database;
            },
          };
        })();
      }

      return MemoryDatabase.#sharedCache;
    }
  }

  export class MemoryRedis extends Redis {
    static readonly #databaseCount = 16;
    static readonly #usedDatabases = new Set<number>();

    #database?: number;

    override async initialize(signal: AbortSignal) {
      const shared = await MemoryRedis.#shared();
      const database = MemoryRedis.#allocateDatabase();

      this.#database = database;

      try {
        process.env.REDIS_URL = `redis://127.0.0.1:${shared.port}/${database}`;

        await super.initialize(signal);
      } catch (error) {
        MemoryRedis.#usedDatabases.delete(database);
        this.#database = undefined;

        throw error;
      }
    }

    override async dispose() {
      const database = this.#database;

      this.#database = undefined;

      try {
        if (database !== undefined) {
          try {
            await this.client.flushdb();
          } catch {
            // The client may not have been initialized if startup failed.
          }
        }
      } finally {
        try {
          await super.dispose();
        } finally {
          if (database !== undefined) {
            MemoryRedis.#usedDatabases.delete(database);
          }
        }
      }
    }

    static async warmup() {
      return MemoryRedis.#shared();
    }

    static async stop() {
      const shared = MemoryRedis.#sharedCache;

      MemoryRedis.#sharedCache = undefined;
      MemoryRedis.#usedDatabases.clear();

      if (!shared) {
        return;
      }

      const resolved = await shared;

      await resolved.server.stop();
    }

    static #allocateDatabase() {
      for (let database = 0; database < MemoryRedis.#databaseCount; database += 1) {
        if (!MemoryRedis.#usedDatabases.has(database)) {
          MemoryRedis.#usedDatabases.add(database);

          return database;
        }
      }

      throw new Error(`No Redis database is available; at most ${MemoryRedis.#databaseCount} MemoryRedis instances are supported.`);
    }

    static #sharedCache?: Promise<{ server: RedisMemoryServer; port: number }>;
    static #shared() {
      if (!MemoryRedis.#sharedCache) {
        MemoryRedis.#sharedCache = (async () => {
          const server = new RedisMemoryServer({
            binary: {
              version: "8.10.2",
            },
          });

          await server.start();

          const port = await server.getPort();

          return { server, port };
        })();
      }

      return MemoryRedis.#sharedCache;
    }
  }
}
