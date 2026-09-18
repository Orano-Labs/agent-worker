import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@/generated/prisma/client";

const createClient = (url: string) => {
  const adapter = new PrismaMariaDb(url);

  return new PrismaClient({
    adapter,
    log: [
      { emit: "event", level: "info" },
      { emit: "event", level: "query" },
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" },
    ],
    transactionOptions: {
      maxWait: 10_000,
      timeout: 10_000 * 6,
    },
  });
};

export class Repository extends Container.ServiceConstructable {
  #client?: ReturnType<typeof createClient>;

  #logger: Logger;
  #environment: Environment;

  constructor(...deps: [Environment, Logger]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("Repository");
  }

  get client() {
    if (!this.#client) {
      throw new Error("Database client is not available");
    }

    return this.#client;
  }

  async transaction<T>(fn: Repository.TxCallback<T>, options?: Repository.TxOptions) {
    const hooksSubscribers = {
      commit: new Set<() => void>(),
      rollback: new Set<(reason: unknown) => void>(),
    };

    const hooks: Repository.TxHooks = {
      on: (hook, callback) => {
        if (hook === "commit") {
          // @ts-expect-error
          hooksSubscribers.commit.add(callback);
        } else if (hook === "rollback") {
          hooksSubscribers.rollback.add(callback);
        }
      },
    };

    try {
      const result = await this.client.$transaction(async (client) => fn({ client, hooks }), options);

      for (const cb of hooksSubscribers.commit) {
        try {
          cb();
        } catch (error) {
          this.#logger.error("Error in commit hook", { err: error });
        }
      }

      return result;
    } catch (e) {
      for (const cb of hooksSubscribers.rollback) {
        try {
          cb(e);
        } catch (error) {
          this.#logger.error("Error in rollback hook", { err: error });
        }
      }

      throw e;
    }
  }

  protected override async initialize(_: AbortSignal) {
    const url = this.#environment.get("MYSQL_URL", true);

    try {
      this.#client = createClient(url);
    } catch (error) {
      throw new Error("Failed to initialize repository client.", { cause: error });
    }

    try {
      await this.#client.$connect();
    } catch (error) {
      throw new Error("Failed to connect to repository.", { cause: error });
    }

    this.#client.$on("query", (event) => {
      this.#logger.debug(event.query, {
        params: event.params,
        duration: event.duration,
        timestamp: event.timestamp,
        target: event.target,
      });
    });

    for (const level of ["info", "warn", "error"] as const) {
      this.#client.$on(level, (event) => {
        this.#logger[level](event.message, {
          timestamp: event.timestamp,
          target: event.target,
        });
      });
    }

    const start = performance.now();

    try {
      await this.#client.$queryRaw`SELECT 1`;

      this.#logger.info("Database ready", {
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      throw new Error("Database unavailable during startup", { cause: err });
    }
  }
}

export namespace Repository {
  export type Client = ReturnType<typeof createClient>;

  export type TxClient = Omit<Client, "$connect" | "$disconnect" | "$on" | "$use" | "$extends">;

  export type TxHooks = {
    on(hook: "commit", callback: () => void): void;
    on(hook: "rollback", callback: (reason: unknown) => void): void;
  };

  export type TxContext = {
    client: TxClient;
    hooks: TxHooks;
  };

  export type TxCallback<T> = (context: TxContext) => Promise<T>;

  export type TxOptions = Parameters<Client["$transaction"]>[1];
}
