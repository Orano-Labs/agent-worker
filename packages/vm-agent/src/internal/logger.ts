import { default as pino } from "pino";
import { default as pretty } from "pino-pretty";

import { Container } from "@/helpers/container";
import { ErrorHelpers } from "@/helpers/error-helpers";
import { CommandLine } from "@/internal/command-line";

const PRODUCTION = process.env.NODE_ENV === "production";

export class Logger {
  #logger: ReturnType<typeof pino>;
  #scope: string[];

  #cli: CommandLine;

  constructor(options?: Logger.Options) {
    this.#cli = Container.inject(CommandLine);

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
          colorize: this.#cli.logColorize ?? !PRODUCTION,
        }),
      );

      if (
        this.#cli.logLevel &&
        ["fatal", "error", "warn", "info", "debug", "trace", "silent"].includes(this.#cli.logLevel)
      ) {
        this.#logger.level = this.#cli.logLevel;
      } else if (PRODUCTION) {
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

  error(message: string, context?: Record<string, unknown>) {
    this.#write("error", message, context);
  }

  errorFrom(error: unknown, message?: string) {
    this.#logger.error(ErrorHelpers.as(error), message);
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
