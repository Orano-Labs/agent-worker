import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { default as Ioredis } from "ioredis";
import { RedisMemoryServer } from "redis-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "@/internal/redis";

describe("Redis", () => {
  let server: RedisMemoryServer;
  let signal: AbortSignal;
  let logger: Logger;
  let logs: Array<{ level: Logger.Level; namespace: string[]; message: string; bindings: Record<string, unknown> }>;
  let environment: Environment;
  let redis: Redis;

  beforeAll(async () => {
    server = new RedisMemoryServer({
      autoStart: false,
      binary: {
        version: "8.10.2",
      },
    });

    await server.start();

    const host = await server.getHost();
    const port = await server.getPort();

    process.env.REDIS_URL = `redis://${host}:${port}`;
  });

  beforeEach(() => {
    signal = new AbortController().signal;
    logs = [];

    class TestEngine extends Logger.Engine {
      get name() {
        return "test.LoggerEngine";
      }

      write(level: Logger.Level, namespace: string[], message: string, bindings: Record<string, unknown>) {
        logs.push({ level, namespace, message, bindings });
      }
    }

    logger = new Logger(new TestEngine());
    environment = new Environment({ files: false });
    redis = new Redis(environment, logger);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await redis[Container.SymbolDispose]();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("registers connection listeners and resolves when the client is ready", async () => {
    const on = vi.spyOn(Ioredis.prototype, "on");

    await redis[Container.SymbolInitialize](signal);

    const registered = (event: string) => on.mock.calls.filter(([name]) => name === event);

    expect(registered("error").length).toBeGreaterThan(0);
    expect(registered("ready").length).toBeGreaterThan(0);
    expect(registered("end").length).toBeGreaterThan(0);
    expect(registered("error")[0]?.[0]).toBe("error");

    await expect(redis.client.ping()).resolves.toBe("PONG");
  });

  it("logs errors emitted by the client", async () => {
    await redis[Container.SymbolInitialize](signal);

    const emitted = new Error("test redis error");

    redis.client.emit("error", emitted);

    expect(logs).toContainEqual({
      level: Logger.Level.Error,
      namespace: ["Redis"],
      message: "Redis client error.",
      bindings: { err: emitted },
    });
  });

  it("rejects initialization when the connection URL is missing", async () => {
    const url = process.env.REDIS_URL;

    delete process.env.REDIS_URL;

    try {
      await expect(redis[Container.SymbolInitialize](signal)).rejects.toThrow('Required environment variable "REDIS_URL" is not set.');
    } finally {
      process.env.REDIS_URL = url;
    }
  });

  it("clears the client during disposal", async () => {
    await redis[Container.SymbolInitialize](signal);

    await redis[Container.SymbolDispose]();

    expect(() => redis.client).toThrow("Redis client is not initialized.");
  });
});
