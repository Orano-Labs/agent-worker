import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import { Redis } from "ioredis";

export class Cache extends Container.ServiceConstructable {
  #client?: Redis;

  #environment: Environment;

  constructor(...deps: [Environment]) {
    super();

    this.#environment = deps[0];
  }

  get client() {
    if (!this.#client) {
      throw new Error("Redis client is not available");
    }

    return this.#client;
  }

  protected override async initialize(_: AbortSignal) {
    const url = this.#environment.get("REDIS_URL", true);

    try {
      const urlObject = new URL(url);

      const password = urlObject.password;
      const username = urlObject.username;
      const host = urlObject.hostname;
      const port = urlObject.port;
      const schema = urlObject.protocol;

      const db = Number.parseInt(urlObject.searchParams.get("db") || "", 10);

      if (schema !== "redis:") {
        throw new Error(`Invalid schema for AW_DIRECTOR_REDIS_URL: ${schema}`);
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

      return;
    } catch (error) {
      throw new Error(`Failed to connect redis server.: ${url}`, { cause: error });
    }
  }

  protected override async dispose(_?: unknown) {
    if (this.#client) {
      this.#client.disconnect(false);
    }
  }
}
