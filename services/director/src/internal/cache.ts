import { Redis } from "ioredis";
import { Container } from "@/helpers/container";
import { Result } from "@/helpers/result";
import { Variables } from "@/internal/variables";

export class Cache {
  #client?: Redis;

  #variables: Variables;

  constructor() {
    this.#variables = Container.inject(Variables);
  }

  get client() {
    if (!this.#client) {
      throw new Error("Redis client is not available");
    }

    return this.#client;
  }

  async init() {
    const url = this.#variables.get("AW_DIRECTOR_REDIS_URL");

    if (!url) {
      return Result.error(new Error("AW_DIRECTOR_REDIS_URL is not set, cannot initialize cache."));
    }

    try {
      const urlObject = new URL(url);

      const password = urlObject.password;
      const username = urlObject.username;
      const host = urlObject.hostname;
      const port = urlObject.port;
      const schema = urlObject.protocol;

      const db = Number.parseInt(urlObject.searchParams.get("db") || "", 10);

      if (schema !== "redis:") {
        return Result.error(new Error(`Invalid schema for AW_DIRECTOR_REDIS_URL: ${schema}`));
      }

      const client = new Redis({
        host: host,
        port: port ? Number.parseInt(port, 10) : 6379,
        password: password === "" ? undefined : password,
        username: username === "" ? undefined : username,
        lazyConnect: true,
        db: Number.isNaN(db) ? 0 : db,
        retryStrategy: (times: number) => {
          return Math.min(times * 50, 2000);
        },
        maxRetriesPerRequest: null,
      });

      await client.connect();
      await client.ping();

      this.#client = client;

      return Result.ok();
    } catch (error) {
      return Result.error(new Error(`Failed to connect redis server.: ${url}`, { cause: error }));
    }
  }
}
