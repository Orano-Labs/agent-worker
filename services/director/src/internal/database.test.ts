import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database } from "@/internal/database";
import { UserTable } from "@/internal/database-schema";
import { TestingUtils } from "@/utils/testing-utils";

describe("Database", () => {
  let signal: AbortSignal;
  let logger: Logger;
  let environment: Environment;
  let database: TestingUtils.MemoryDatabase;

  beforeAll(async () => {
    await TestingUtils.MemoryDatabase.warmup();
  }, 120_000);

  beforeEach(async () => {
    signal = new AbortController().signal;

    logger = new Logger();
    environment = new Environment({ files: false });
    database = new TestingUtils.MemoryDatabase(environment, logger);

    await database.initialize(signal);
  }, 120_000);

  afterEach(async () => {
    await database.dispose();
  });

  afterAll(async () => {
    await TestingUtils.MemoryDatabase.stop();
  }, 120_000);

  it("throws when pool or client is accessed before initialization", () => {
    const uninitialized = new TestingUtils.MemoryDatabase(environment, logger);

    expect(() => uninitialized.pool).toThrow("Database pool is not initialized.");
    expect(() => uninitialized.client).toThrow("Database client is not initialized.");
  });

  it("connects to MySQL and exposes a working pool", async () => {
    const [rows] = await database.pool.query<RowDataPacket[]>("SELECT 1 AS value");

    expect(rows).toEqual([{ value: 1 }]);
  });

  it("runs migrations and exposes a working drizzle client", async () => {
    const [tables] = await database.pool.query<RowDataPacket[]>("SHOW TABLES");
    const names = tables.map((table) => Object.values(table)[0]);

    expect(names).toEqual(expect.arrayContaining(["instance", "project", "supervisor", "template", "user"]));

    await expect(database.client.select().from(UserTable)).resolves.toEqual([]);
  });

  it("clears pool and client after dispose", async () => {
    await database.dispose();

    expect(() => database.pool).toThrow("Database pool is not initialized.");
    expect(() => database.client).toThrow("Database client is not initialized.");
  });

  it("rejects initialization when DATABASE_URL is missing", async () => {
    const url = process.env.DATABASE_URL;

    delete process.env.DATABASE_URL;

    try {
      const missingEnvironment = new Environment({ files: false });
      const uninitialized = new Database(missingEnvironment, logger);

      await expect(uninitialized[Container.SymbolInitialize](signal)).rejects.toThrow(
        'Required environment variable "DATABASE_URL" is not set.',
      );
    } finally {
      if (url !== undefined) {
        process.env.DATABASE_URL = url;
      }
    }
  });

  it("rejects initialization when the signal is already aborted", async () => {
    const controller = new AbortController();
    const abortedEnvironment = { get: () => "unused" } as unknown as Environment;
    const uninitialized = new Database(abortedEnvironment, logger);

    controller.abort(new Error("terminated"));

    await expect(uninitialized[Container.SymbolInitialize](controller.signal)).rejects.toThrow("Database initialization aborted.");
  });
});
