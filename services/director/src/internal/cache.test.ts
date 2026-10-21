import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Cache } from "@/internal/cache-new";
import { TestingUtils } from "@/utils/testing-utils";

describe("Cache", () => {
  let signal: AbortSignal;
  let logger: Logger;
  let environment: Environment;
  let redis: TestingUtils.MemoryRedis;
  let cache: Cache;

  beforeAll(async () => {
    await TestingUtils.MemoryRedis.warmup();
  });

  beforeEach(async () => {
    signal = new AbortController().signal;
    logger = new Logger();
    environment = new Environment();
    redis = new TestingUtils.MemoryRedis(environment, logger);
    cache = new Cache(environment, logger, redis);

    await redis.initialize(signal);
  });

  afterEach(async () => {
    await redis.dispose();
  });

  afterAll(async () => {
    await TestingUtils.MemoryRedis.stop();
  });

  const namespace = (prefix: string) => {
    return Cache.namespace({
      prefix,
      encode: (value: { id: number }) => JSON.stringify(value),
      decode: (value: string) => JSON.parse(value) as { id: number },
    });
  };

  it("sets and gets a value", async () => {
    const ns = namespace("cache-get");

    await cache.set(ns, "user", { id: 1 });

    await expect(cache.get(ns, "user")).resolves.toEqual({ value: { id: 1 }, expiresAt: undefined });
    await expect(cache.get(ns, "missing")).resolves.toBeUndefined();
  });

  it("computes the key once per operation", async () => {
    let calls = 0;

    const ns = Cache.namespace({
      prefix: "cache-key-once",
      encode: (value: { id: number }) => JSON.stringify(value),
      decode: (value: string) => JSON.parse(value) as { id: number },
      key: (value: string) => {
        calls += 1;

        return value;
      },
    });

    await cache.set(ns, "a", { id: 1 });
    calls = 0;

    await expect(cache.get(ns, "a")).resolves.toEqual({ value: { id: 1 }, expiresAt: undefined });
    expect(calls).toBe(1);
  });

  it("gets and sets many values", async () => {
    const ns = namespace("cache-many");

    await cache.setMany(ns, [
      ["a", { id: 1 }],
      ["b", { id: 2 }],
      ["c", { id: 3 }, 10_000],
    ]);

    await expect(cache.getMany(ns, ["a", "b", "c"])).resolves.toEqual([
      { key: "a", value: { id: 1 }, expiresAt: undefined },
      { key: "b", value: { id: 2 }, expiresAt: undefined },
      { key: "c", value: { id: 3 }, expiresAt: expect.any(Number) },
    ]);
    await expect(cache.getMany(ns, ["a", "missing"])).resolves.toEqual([{ key: "a", value: { id: 1 }, expiresAt: undefined }, undefined]);
  });

  it("checks and deletes keys", async () => {
    const ns = namespace("cache-has");

    await cache.setMany(ns, [
      ["a", { id: 1 }],
      ["b", { id: 2 }],
      ["c", { id: 3 }],
    ]);

    await expect(cache.has(ns, "a")).resolves.toBe(true);
    await expect(cache.has(ns, "missing")).resolves.toBe(false);
    await expect(cache.hasMany(ns, ["a", "missing", "c"])).resolves.toEqual([true, false, true]);
    await expect(cache.hasMany(ns, ["a", "a", "missing"])).resolves.toEqual([true, true, false]);

    await expect(cache.delete(ns, "a")).resolves.toBe(true);
    await expect(cache.delete(ns, "a")).resolves.toBe(false);
    await expect(cache.deleteMany(ns, ["b", "missing"])).resolves.toBe(true);
    await expect(cache.deleteMany(ns, [])).resolves.toBe(false);

    await expect(cache.getMany(ns, ["a", "b", "c"])).resolves.toEqual([
      undefined,
      undefined,
      { key: "c", value: { id: 3 }, expiresAt: undefined },
    ]);
  });

  it("expires values with a per-entry or namespace ttl", async () => {
    const ns = Cache.namespace({
      prefix: "cache-ttl",
      encode: String,
      decode: Number,
      ttl: 200,
    });

    const before = Date.now();

    await cache.set(ns, "a", 1);
    await cache.set(ns, "b", 2, 200);
    await cache.set(ns, "c", 3, 10_000);

    await expect(cache.get(ns, "a")).resolves.toEqual({ value: 1, expiresAt: expect.any(Number) });
    await expect(cache.get(ns, "b")).resolves.toEqual({ value: 2, expiresAt: expect.any(Number) });
    await expect(cache.stats(ns)).resolves.toMatchObject({ count: 3, expiring: 3, ttl: 200 });

    const expiresAt = (await cache.get(ns, "a"))?.expiresAt;

    expect(expiresAt).toBeGreaterThanOrEqual(before + 200);

    await new Promise((resolve) => setTimeout(resolve, 400));

    await expect(cache.get(ns, "a")).resolves.toBeUndefined();
    await expect(cache.get(ns, "b")).resolves.toBeUndefined();
    await expect(cache.get(ns, "c")).resolves.toEqual({ value: 3, expiresAt: expect.any(Number) });
    await expect(cache.stats(ns)).resolves.toMatchObject({ count: 1, expiring: 1 });
  });

  it("clears keys matching a glob", async () => {
    const ns = namespace("cache-clear-glob");

    await cache.setMany(ns, [
      ["user:1", { id: 1 }],
      ["user:2", { id: 2 }],
      ["session:1", { id: 3 }],
    ]);

    await expect(cache.clear(ns, "user:*")).resolves.toBe(true);
    await expect(cache.getMany(ns, ["user:1", "user:2", "session:1"])).resolves.toEqual([
      undefined,
      undefined,
      { key: "session:1", value: { id: 3 }, expiresAt: undefined },
    ]);

    await expect(cache.clear(ns, "missing:*")).resolves.toBe(false);
  });

  it("clears only the namespace and reports stats", async () => {
    const ns = namespace("cache-clear");
    const other = namespace("cache-clear-other");

    await cache.setMany(ns, [
      ["a", { id: 1 }],
      ["b", { id: 2 }],
    ]);
    await cache.set(other, "a", { id: 3 });

    const before = await cache.stats(ns);

    expect(before).toMatchObject({ count: 2, expiring: 0, ttl: undefined });
    expect(before.memory).toBeGreaterThan(0);

    await expect(cache.clear(ns)).resolves.toBe(true);

    await expect(cache.stats(ns)).resolves.toMatchObject({ count: 0, expiring: 0, memory: 0 });
    await expect(cache.getMany(ns, ["a", "b"])).resolves.toEqual([undefined, undefined]);
    await expect(cache.get(other, "a")).resolves.toEqual({ value: { id: 3 }, expiresAt: undefined });
  });

  it("iterates namespace entries with an optional glob", async () => {
    const ns = namespace("cache-iterator");

    await cache.setMany(ns, [
      ["user:1", { id: 1 }],
      ["user:2", { id: 2 }],
      ["session:1", { id: 3 }],
      ["ttl:1", { id: 4 }, 10_000],
    ]);

    const all: { key: string; value: { id: number }; expiresAt: number | undefined }[] = [];

    for await (const entry of cache.iterator(ns)) {
      all.push(entry);
    }

    expect(all).toEqual(
      expect.arrayContaining([
        { key: "user:1", value: { id: 1 }, expiresAt: undefined },
        { key: "user:2", value: { id: 2 }, expiresAt: undefined },
        { key: "session:1", value: { id: 3 }, expiresAt: undefined },
        { key: "ttl:1", value: { id: 4 }, expiresAt: expect.any(Number) },
      ]),
    );

    const users: { key: string; value: { id: number }; expiresAt: number | undefined }[] = [];

    for await (const entry of cache.iterator(ns, "user:*")) {
      users.push(entry);
    }

    expect(users).toEqual(
      expect.arrayContaining([
        { key: "user:1", value: { id: 1 }, expiresAt: undefined },
        { key: "user:2", value: { id: 2 }, expiresAt: undefined },
      ]),
    );
    expect(users).toHaveLength(2);
  });

  it("escapes special characters in namespace prefixes", async () => {
    const ns = namespace("cache-special[*]\n?");
    const other = namespace("cache-specialXX");

    await cache.set(ns, "a", { id: 1 });
    await cache.set(other, "a", { id: 2 });

    const entries: { key: string; value: { id: number }; expiresAt: number | undefined }[] = [];

    for await (const entry of cache.iterator(ns)) {
      entries.push(entry);
    }

    expect(entries).toEqual([{ key: "a", value: { id: 1 }, expiresAt: undefined }]);
    await expect(cache.stats(ns)).resolves.toMatchObject({ count: 1 });

    await cache.clear(ns);

    await expect(cache.get(ns, "a")).resolves.toBeUndefined();
    await expect(cache.get(other, "a")).resolves.toEqual({ value: { id: 2 }, expiresAt: undefined });
  });

  it("ignores non-string keys in the namespace", async () => {
    const ns = namespace("cache-types");
    const hashKey = `${ns.prefix}::hash`;

    await cache.set(ns, "string", { id: 1 });
    await redis.client.hset(hashKey, "field", "value");

    await expect(cache.stats(ns)).resolves.toMatchObject({ count: 1 });

    const entries: { key: string; value: { id: number }; expiresAt: number | undefined }[] = [];

    for await (const entry of cache.iterator(ns)) {
      entries.push(entry);
    }

    expect(entries).toEqual([{ key: "string", value: { id: 1 }, expiresAt: undefined }]);

    await cache.clear(ns);

    await expect(cache.get(ns, "string")).resolves.toBeUndefined();
    await expect(redis.client.exists(hashKey)).resolves.toBe(1);
  });

  it("requires unique prefixes", () => {
    namespace("cache-duplicate");

    expect(() => namespace("cache-duplicate")).toThrow('Cache namespace prefix "cache-duplicate" is already registered.');
  });

  it("builds keys with a custom key function", () => {
    const ns = Cache.namespace<number, number>({
      prefix: "cache-keyer",
      encode: String,
      decode: Number,
      key: (value) => String(value),
    });

    expect(ns.key(1)).toBe("cache-keyer::1");
  });
});
