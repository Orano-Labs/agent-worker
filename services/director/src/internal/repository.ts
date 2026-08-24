import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@/generated/prisma/client";
import { Container } from "@/helpers/container";
import { Result } from "@/helpers/result";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

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

export class Repository {
  #client?: ReturnType<typeof createClient>;

  #logger: Logger;
  #variables: Variables;

  constructor() {
    this.#variables = Container.inject(Variables);
    this.#logger = Container.inject(Logger).scope("Repository");
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
      // 执行事务
      const result = await this.client.$transaction(async (client) => fn({ client, hooks }), options);

      // 事务成功，执行所有提交钩子
      for (const cb of hooksSubscribers.commit) {
        try {
          cb();
        } catch (error) {
          this.#logger.errorFrom(error, "Error in commit hook");
        }
      }

      return result;
    } catch (e) {
      // 事务失败，执行所有回滚钩子
      for (const cb of hooksSubscribers.rollback) {
        try {
          cb(e);
        } catch (error) {
          this.#logger.errorFrom(error, "Error in rollback hook");
        }
      }

      throw e;
    }
  }

  async init(): Promise<Result<void, Error>> {
    const url = this.#variables.get("AW_DIRECTOR_MYSQL_URL");

    if (!url) {
      return Result.error(new Error("AW_DIRECTOR_MYSQL_URL is not set, cannot initialize repository."));
    }

    try {
      this.#client = createClient(url);
    } catch (error) {
      return Result.error(new Error("Failed to initialize repository client.", { cause: error }));
    }

    try {
      await this.#client.$connect();
    } catch (error) {
      return Result.error(new Error("Failed to connect to repository.", { cause: error }));
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
      return Result.error(new Error("Database unavailable during startup", { cause: err }));
    }

    return Result.ok();
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
