import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { Redis as Ioredis } from "ioredis";

export class Redis extends Container.ServiceConstructable {
  #environment: Environment;
  #logger: Logger;

  #client?: Ioredis;

  constructor(...deps: [Environment, Logger]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("Redis");
  }

  get client() {
    if (!this.#client) {
      throw new Error("Redis client is not initialized.");
    }

    return this.#client;
  }

  protected override async initialize(_signal: AbortSignal) {
    const connectionString = this.#environment.get("REDIS_URL", true);

    const client = new Ioredis(connectionString, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });

    client.on("error", (error) => {
      this.#logger.error("Redis client error.", { err: error });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        // "ready" fires once the connection handshake (including AUTH/SELECT)
        // completes and the client can reliably send commands.

        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onEnd = () => {
          cleanup();
          reject(new Error("Redis connection ended before becoming ready."));
        };

        const cleanup = () => {
          client.off("ready", onReady);
          client.off("error", onError);
          client.off("end", onEnd);
        };

        client.on("ready", onReady);
        client.on("error", onError);
        client.on("end", onEnd);
      });
    } catch (error) {
      client.disconnect();

      throw new Error("Failed to connect to Redis.", { cause: error });
    }

    this.#client = client;

    this.#logger.info("Redis client connected successfully.");
  }

  protected override async dispose() {
    const client = this.#client;

    if (client === undefined) {
      return;
    }

    this.#client = undefined;

    try {
      await client.quit();
      this.#logger.info("Redis client closed gracefully.");
    } catch {
      client.disconnect();
      this.#logger.warn("Redis client did not respond to quit; connection force-closed.");
    }
  }
}
