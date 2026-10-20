import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { Redis } from "@/internal/redis";

const KEY_SEPARATOR = "::";
const SCAN_BATCH_SIZE = 100;
const DELETE_BATCH_SIZE = 1000;

export class Cache extends Container.ServiceConstructable {
  #environment: Environment;
  #logger: Logger;
  #redis: Redis;

  constructor(...deps: [Environment, Logger, Redis]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("Redis");
    this.#redis = deps[2];
  }

  async get<V, K>(ns: Cache.Namespace<V, K>, key: K) {
    return this.#execute("get", ns.prefix, async () => {
      const encodedKey = ns.key(key);
      const results = await this.#redis.client.multi().get(encodedKey).pexpiretime(encodedKey).exec();
      const failure = results?.find(([error]) => error !== null);

      if (results === null || failure?.[0]) {
        throw failure?.[0] ?? new Error("Cache get transaction was aborted.");
      }

      const value = results[0]?.[1];
      const expireAt = results?.[1]?.[1];

      if (typeof value !== "string") {
        return undefined;
      }

      return { value: ns.decode(value), expiresAt: typeof expireAt === "number" && expireAt >= 0 ? expireAt : undefined };
    });
  }

  async getMany<V, K>(ns: Cache.Namespace<V, K>, keys: K[]) {
    if (keys.length === 0) {
      return [];
    }

    return this.#execute("getMany", ns.prefix, async () => {
      const pipeline = this.#redis.client.multi();

      for (const key of keys) {
        const encodedKey = ns.key(key);

        pipeline.get(encodedKey);
        pipeline.pexpiretime(encodedKey);
      }

      const results = await pipeline.exec();
      const failure = results?.find(([error]) => error !== null);

      if (results === null || failure?.[0]) {
        throw failure?.[0] ?? new Error("Cache getMany transaction was aborted.");
      }

      const entries: (Cache.KeyedEntry<V, K> | undefined)[] = [];

      for (const [index, key] of keys.entries()) {
        const value = results?.[index * 2]?.[1];
        const expireAt = results?.[index * 2 + 1]?.[1];

        if (typeof value !== "string") {
          entries.push(undefined);

          continue;
        }

        entries.push({
          key,
          value: ns.decode(value),
          expiresAt: typeof expireAt === "number" && expireAt >= 0 ? expireAt : undefined,
        });
      }

      return entries;
    });
  }

  async set<V, K>(ns: Cache.Namespace<V, K>, key: K, value: V, ttl?: number) {
    return this.#execute("set", ns.prefix, async () => {
      const expiresIn = this.#resolveTtl(ns.ttl, ttl);

      if (expiresIn === undefined) {
        await this.#redis.client.set(ns.key(key), ns.encode(value));
      } else {
        await this.#redis.client.set(ns.key(key), ns.encode(value), "PX", expiresIn);
      }
    });
  }

  async setMany<V, K>(ns: Cache.Namespace<V, K>, entries: [K, V, number?][]) {
    if (entries.length === 0) {
      return;
    }

    return this.#execute("setMany", ns.prefix, async () => {
      const pipeline = this.#redis.client.multi();

      for (const [key, value, ttl] of entries) {
        const expiresIn = this.#resolveTtl(ns.ttl, ttl);

        if (expiresIn === undefined) {
          pipeline.set(ns.key(key), ns.encode(value));
        } else {
          pipeline.set(ns.key(key), ns.encode(value), "PX", expiresIn);
        }
      }

      const results = await pipeline.exec();
      const failure = results?.find(([error]) => error !== null);

      if (results === null || failure?.[0]) {
        throw failure?.[0] ?? new Error("Cache setMany transaction was aborted.");
      }
    });
  }

  async has<V, K>(ns: Cache.Namespace<V, K>, key: K) {
    return this.#execute("has", ns.prefix, async () => {
      return (await this.#redis.client.exists(ns.key(key))) > 0;
    });
  }

  async hasMany<V, K>(ns: Cache.Namespace<V, K>, keys: K[]) {
    if (keys.length === 0) {
      return [];
    }

    return this.#execute("hasMany", ns.prefix, async () => {
      const pipeline = this.#redis.client.multi();

      for (const key of keys) {
        pipeline.exists(ns.key(key));
      }

      const results = await pipeline.exec();
      const failure = results?.find(([error]) => error !== null);

      if (results === null || failure?.[0]) {
        throw failure?.[0] ?? new Error("Cache hasMany transaction was aborted.");
      }

      return keys.map((_, index) => {
        const result = results?.[index]?.[1];

        return typeof result === "number" && result > 0;
      });
    });
  }

  async delete<V, K>(ns: Cache.Namespace<V, K>, key: K) {
    return this.#execute("delete", ns.prefix, async () => {
      return (await this.#redis.client.unlink(ns.key(key))) > 0;
    });
  }

  async deleteMany<V, K>(ns: Cache.Namespace<V, K>, keys: K[]) {
    if (keys.length === 0) {
      return false;
    }

    return this.#execute("deleteMany", ns.prefix, async () => {
      return (await this.#unlink(keys.map((key) => ns.key(key)))) > 0;
    });
  }

  async clear<V, K>(ns: Cache.Namespace<V, K>, glob = "*") {
    return this.#execute("clear", ns.prefix, async () => {
      let deleted = 0;

      await this.#scan(this.#match(ns.prefix, glob), async (keys) => {
        deleted += await this.#unlink(keys);
      });

      return deleted > 0;
    });
  }

  async stats<V, K>(ns: Cache.Namespace<V, K>) {
    return this.#execute("stats", ns.prefix, async () => {
      const keys = new Set<string>();
      let expiring = 0;
      let memory = 0;

      await this.#scan(this.#match(ns.prefix), async (batch) => {
        const fresh = batch.filter((key) => !keys.has(key));

        if (fresh.length === 0) {
          return;
        }

        for (const key of fresh) {
          keys.add(key);
        }

        const pipeline = this.#redis.client.multi();

        for (const key of fresh) {
          pipeline.pexpiretime(key);
          pipeline.memory("USAGE", key);
        }

        const results = await pipeline.exec();
        const failure = results?.find(([error]) => error !== null);

        if (results === null || failure?.[0]) {
          throw failure?.[0] ?? new Error("Cache stats transaction was aborted.");
        }

        for (const [index] of fresh.entries()) {
          const expireAt = results?.[index * 2]?.[1];
          const usage = results?.[index * 2 + 1]?.[1];

          if (typeof expireAt === "number" && expireAt >= 0) {
            expiring += 1;
          }

          if (typeof usage === "number") {
            memory += usage;
          }
        }
      });

      return {
        count: keys.size,
        expiring,
        memory,
        ttl: Number.isFinite(ns.ttl) && ns.ttl > 0 ? ns.ttl : undefined,
      };
    });
  }

  async *iterator<V, K>(ns: Cache.Namespace<V, K>, glob = "*"): AsyncGenerator<Cache.KeyedEntry<V, string>, void, void> {
    const pattern = this.#match(ns.prefix, glob);
    const prefixLength = ns.prefix.length + KEY_SEPARATOR.length;
    const seen = new Set<string>();

    let cursor = "0";

    do {
      let keys: string[];

      try {
        [cursor, keys] = await this.#redis.client.scan(cursor, "MATCH", pattern, "COUNT", SCAN_BATCH_SIZE, "TYPE", "string");
      } catch (error) {
        this.#logger.error("Cache iterator failed.", { namespace: ns.prefix, mode: this.#environment.mode, err: error });

        throw error;
      }

      const fresh = keys.filter((key) => !seen.has(key));

      if (fresh.length === 0) {
        continue;
      }

      for (const key of fresh) {
        seen.add(key);
      }

      const pipeline = this.#redis.client.multi();

      for (const key of fresh) {
        pipeline.get(key);
        pipeline.pexpiretime(key);
      }

      let results: Awaited<ReturnType<typeof pipeline.exec>>;

      try {
        results = await pipeline.exec();

        const failure = results?.find(([error]) => error !== null);

        if (results === null || failure?.[0]) {
          throw failure?.[0] ?? new Error("Cache iterator transaction was aborted.");
        }
      } catch (error) {
        this.#logger.error("Cache iterator failed.", { namespace: ns.prefix, mode: this.#environment.mode, err: error });

        throw error;
      }

      for (const [index, key] of fresh.entries()) {
        const value = results?.[index * 2]?.[1];
        const expireAt = results?.[index * 2 + 1]?.[1];

        if (typeof value !== "string") {
          continue;
        }

        yield {
          key: key.slice(prefixLength),
          value: ns.decode(value),
          expiresAt: typeof expireAt === "number" && expireAt >= 0 ? expireAt : undefined,
        };
      }
    } while (cursor !== "0");
  }

  /**
   * Build a SCAN/MATCH pattern.
   *
   * Escaping is applied to the namespace prefix only here, never to keys used
   * by regular commands, otherwise lookups would compare against the escaped
   * form.
   */
  #match(prefix: string, glob = "*") {
    return `${prefix.replace(/[*?[\]\\]/g, "\\$&")}${KEY_SEPARATOR}${glob}`;
  }

  #resolveTtl(fallback: number, ttl?: number) {
    const value = ttl ?? fallback;

    if (!Number.isFinite(value) || value <= 0) {
      return undefined;
    }

    return Math.max(1, Math.floor(value));
  }

  async #scan(pattern: string, handle: (keys: string[]) => Promise<void>) {
    let cursor = "0";

    do {
      const [nextCursor, keys] = await this.#redis.client.scan(cursor, "MATCH", pattern, "COUNT", SCAN_BATCH_SIZE, "TYPE", "string");

      cursor = nextCursor;

      if (keys.length > 0) {
        await handle(keys);
      }
    } while (cursor !== "0");
  }

  async #unlink(keys: string[]) {
    let deleted = 0;

    for (let index = 0; index < keys.length; index += DELETE_BATCH_SIZE) {
      deleted += await this.#redis.client.unlink(...keys.slice(index, index + DELETE_BATCH_SIZE));
    }

    return deleted;
  }

  async #execute<T>(operation: string, namespace: string, action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      this.#logger.error(`Cache ${operation} failed.`, {
        namespace,
        mode: this.#environment.mode,
        err: error,
      });

      throw error;
    }
  }

  static namespace<V, K = string>(options: Cache.Namespace.Options<V, K>) {
    return new Cache.Namespace(options);
  }
}

export namespace Cache {
  export type Dependencies = {
    readonly logger: Logger;
    readonly environment: Environment;
    readonly redis: Redis;
  };

  export type Entry<V> = {
    value: V;
    /** Absolute expiration time as a Unix timestamp in milliseconds, or undefined when the key does not expire. */
    expiresAt: number | undefined;
  };

  export type KeyedEntry<V, K> = Entry<V> & {
    key: K;
  };

  export type Stats = {
    /** Number of distinct keys currently stored in the namespace. */
    count: number;
    /** Number of keys with an expiration time. */
    expiring: number;
    /** Total memory usage of the namespace keys in bytes. */
    memory: number;
    /** Default namespace time to live in milliseconds; undefined when keys do not expire by default. */
    ttl: number | undefined;
  };

  export class Namespace<V = unknown, K = string> {
    #prefix: string;
    #ttl: number;

    #encoder: (value: V) => string;
    #decoder: (value: string) => V;

    #keyer?: (value: K) => string;

    constructor(options: Namespace.Options<V, K>) {
      if (options.prefix.length === 0) {
        throw new Error("Cache namespace prefix must not be empty.");
      }

      if (Namespace.#uniquePrefix.has(options.prefix)) {
        throw new Error(`Cache namespace prefix "${options.prefix}" is already registered.`);
      }

      this.#prefix = options.prefix;
      this.#ttl = options.ttl ?? Infinity;

      this.#encoder = options.encode;
      this.#decoder = options.decode;

      this.#keyer = options.key;

      Namespace.#uniquePrefix.add(this.#prefix);
    }

    get prefix() {
      return this.#prefix;
    }

    get ttl() {
      return this.#ttl;
    }

    key(value: K) {
      if (this.#keyer) {
        return `${this.#prefix}${KEY_SEPARATOR}${this.#keyer(value)}`;
      }

      if (typeof value === "string") {
        return `${this.#prefix}${KEY_SEPARATOR}${value}`;
      }

      throw new Error(`Cache namespace "${this.#prefix}" requires a key function for non-string keys.`);
    }

    encode(value: V) {
      return this.#encoder(value);
    }

    decode(value: string) {
      return this.#decoder(value);
    }

    static #uniquePrefix = new Set<string>();
  }

  export namespace Namespace {
    export type Options<V, K> = {
      encode: (value: V) => string;
      decode: (value: string) => V;
      prefix: string;
      /** Default time to live in milliseconds. Non-positive or infinite values disable expiration. */
      ttl?: number;
    } & (K extends string
      ? {
          key?: (value: K) => string;
        }
      : {
          key: (value: K) => string;
        });

    export type Key<T> = T extends Namespace<infer _, infer V> ? V : never;
    export type Value<T> = T extends Namespace<infer V, infer _> ? V : never;
  }
}
