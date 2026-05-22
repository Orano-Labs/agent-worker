import { asError } from "catch-unknown";
import { default as pino } from "pino";
import { default as pretty } from "pino-pretty";
import { Container } from "@/helpers/container";

const PRODUCTION = process.env.NODE_ENV === "production";

export class Logger {
  #logger: ReturnType<typeof pino>;
  #scope: string[];

  constructor(options?: Logger.Options) {
    this.#scope = [];

    if (options?.parent) {
      this.#scope = [...options.parent.#scope];

      if (options.scope) {
        this.#scope.push(options.scope);
      }

      this.#logger = options.parent.#logger.child(options.context || {}, {
        msgPrefix: `[${this.#scope.join("::")}] `,
      });
    } else {
      this.#logger = pino(
        pretty({
          customPrettifiers: {
            level: (_data, _key, _log, extra) => {
              return extra.labelColorized.replace(extra.label, extra.label.padEnd(5));
            },
          },
        }),
      );

      if (PRODUCTION) {
        this.#logger.level = "info";
      } else {
        this.#logger.level = "trace";
      }
    }
  }

  #write(level: Logger.Level, message: string, context?: Logger.Context) {
    if (context) {
      this.#logger[level](context, message);
    } else {
      this.#logger[level](message);
    }
  }

  info(message: string, context?: Record<string, unknown>) {
    this.#write("info", message, context);
  }

  debug(message: string, context?: Record<string, unknown>) {
    this.#write("debug", message, context);
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.#write("warn", message, context);
  }

  trace(message: string, context?: Record<string, unknown>) {
    this.#write("trace", message, context);
  }

  fatal(message: string, context?: Record<string, unknown>) {
    this.#write("fatal", message, context);
  }

  fatalFrom(error: unknown, message?: string) {
    this.#logger.fatal(asError(error), message);
  }

  error(message: string, context?: Record<string, unknown>) {
    this.#write("error", message, context);
  }

  errorFrom(error: unknown, message?: string) {
    this.#logger.error(asError(error), message);
  }

  scope(prefix: string, context?: Logger.Context) {
    return new Logger({ parent: this, scope: prefix, context });
  }

  with(context: Logger.Context) {
    return new Logger({ parent: this, context });
  }
}

export namespace Logger {
  export type Context = Record<string, unknown>;

  export type Level = "info" | "debug" | "warn" | "trace" | "fatal" | "error";

  export type Options = {
    parent?: Logger;
    context?: Context;
    scope?: string;
  };
}

Container.singleton(Logger, () => new Logger());
