import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TestingUtils } from "@/utils/testing-utils";

const createEnvironment = () => new Environment({ files: false });

describe("TestingUtils.MemoryDatabase", () => {
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
    environment = createEnvironment();
    database = new TestingUtils.MemoryDatabase(environment, logger);

    await database.initialize(signal);
  }, 120_000);

  afterEach(async () => {
    await database.dispose();
  });

  afterAll(async () => {
    await TestingUtils.MemoryDatabase.stop();
  }, 120_000);

  it("sets the test database connection string", () => {
    expect(process.env.DATABASE_URL).toMatch(/^mysql:\/\/[^/]+@127\.0\.0\.1:\d+\/test_[0-9a-f]+$/);
  });

  it("runs migrations and provides a connected pool", async () => {
    const [rows] = await database.pool.query<RowDataPacket[]>("SELECT 1 AS value");
    const [tables] = await database.pool.query<RowDataPacket[]>("SHOW TABLES LIKE 'user'");

    expect(rows).toEqual([{ value: 1 }]);
    expect(tables).toHaveLength(1);
  });

  it("throws when the pool is accessed before initialization", () => {
    const uninitialized = new TestingUtils.MemoryDatabase(environment, logger);

    expect(() => uninitialized.pool).toThrow("Database pool is not initialized.");
  });

  it("throws when the pool is accessed after dispose", async () => {
    await database.dispose();

    expect(() => database.pool).toThrow("Database pool is not initialized.");
  });

  it("creates an isolated database per instance", async () => {
    const another = new TestingUtils.MemoryDatabase(environment, logger);

    await another.initialize(signal);

    try {
      const [first] = await database.pool.query<RowDataPacket[]>("SELECT DATABASE() AS name");
      const [second] = await another.pool.query<RowDataPacket[]>("SELECT DATABASE() AS name");

      expect(first[0]?.name).not.toBe(second[0]?.name);
    } finally {
      await another.dispose();
    }
  });

  it("reuses the shared embedded mysql instance", async () => {
    const first = await TestingUtils.MemoryDatabase.warmup();
    const second = await TestingUtils.MemoryDatabase.warmup();

    expect(first).toBe(second);
  });
});

describe("TestingUtils.MemoryRedis", () => {
  let signal: AbortSignal;
  let logger: Logger;
  let environment: Environment;
  let redis: TestingUtils.MemoryRedis;

  beforeAll(async () => {
    await TestingUtils.MemoryRedis.warmup();
  }, 120_000);

  beforeEach(async () => {
    signal = new AbortController().signal;

    logger = new Logger();
    environment = createEnvironment();
    redis = new TestingUtils.MemoryRedis(environment, logger);

    await redis.initialize(signal);
  }, 120_000);

  afterEach(async () => {
    await redis.dispose();
  });

  afterAll(async () => {
    await TestingUtils.MemoryRedis.stop();
  }, 120_000);

  it("sets the test redis connection string", () => {
    expect(process.env.REDIS_URL).toMatch(/^redis:\/\/127\.0\.0\.1:\d+\/\d+$/);
  });

  it("provides a connected client", async () => {
    await expect(redis.client.ping()).resolves.toBe("PONG");
  });

  it("throws when the client is accessed before initialization", () => {
    const uninitialized = new TestingUtils.MemoryRedis(environment, logger);

    expect(() => uninitialized.client).toThrow("Redis client is not initialized.");
  });

  it("throws when the client is accessed after dispose", async () => {
    await redis.dispose();

    expect(() => redis.client).toThrow("Redis client is not initialized.");
  });

  it("creates an isolated database per instance", async () => {
    const firstUrl = process.env.REDIS_URL;
    const another = new TestingUtils.MemoryRedis(environment, logger);

    await another.initialize(signal);

    try {
      expect(firstUrl).toMatch(/^redis:\/\/127\.0\.0\.1:\d+\/\d+$/);
      expect(process.env.REDIS_URL).toMatch(/^redis:\/\/127\.0\.0\.1:\d+\/\d+$/);

      const firstDatabase = Number(new URL(firstUrl ?? "").pathname.slice(1));
      const secondDatabase = Number(new URL(process.env.REDIS_URL ?? "").pathname.slice(1));

      expect(firstDatabase).not.toBe(secondDatabase);

      await redis.client.set("isolated-key", "first-value");
      await expect(redis.client.get("isolated-key")).resolves.toBe("first-value");
      await expect(another.client.get("isolated-key")).resolves.toBeNull();
    } finally {
      await redis.client.del("isolated-key");
      await another.dispose();
    }
  });

  it("clears data when releasing a database during disposal", async () => {
    await redis.client.set("temporary-key", "temporary-value");

    const another = new TestingUtils.MemoryRedis(environment, logger);

    await redis.dispose();

    await another.initialize(signal);

    try {
      await expect(another.client.get("temporary-key")).resolves.toBeNull();
    } finally {
      await another.dispose();
    }
  });

  it("limits active instances and reuses released databases", async () => {
    const instances: Array<TestingUtils.MemoryRedis> = [];

    try {
      for (let index = 0; index < 15; index += 1) {
        const instance = new TestingUtils.MemoryRedis(environment, logger);

        await instance.initialize(signal);
        instances.push(instance);
      }

      const exhausted = new TestingUtils.MemoryRedis(environment, logger);

      await expect(exhausted.initialize(signal)).rejects.toThrow(
        "No Redis database is available; at most 16 MemoryRedis instances are supported.",
      );
      await exhausted.dispose();

      const released = instances.pop();

      await released?.dispose();

      const replacement = new TestingUtils.MemoryRedis(environment, logger);

      await expect(replacement.initialize(signal)).resolves.toBeUndefined();
      instances.push(replacement);
    } finally {
      for (const instance of instances.reverse()) {
        await instance.dispose();
      }
    }
  });

  it("reuses the shared embedded redis instance", async () => {
    const first = await TestingUtils.MemoryRedis.warmup();
    const second = await TestingUtils.MemoryRedis.warmup();

    expect(first).toBe(second);
  });
});
