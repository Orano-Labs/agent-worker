import { default as pino } from "pino";
import { default as pretty } from "pino-pretty";

import { ErrorHelpers } from "@/helpers/error-helpers";

const PRODUCTION = process.env.NODE_ENV === "production";
const ENGINE = pino(
  pretty({
    customPrettifiers: {
      level: (_data, _key, _log, extra) => {
        return extra.labelColorized.replace(extra.label, extra.label.padEnd(5));
      },
    },
    colorize: !PRODUCTION,
  }),
);

if (PRODUCTION) {
  ENGINE.level = "info";
} else {
  ENGINE.level = "trace";
}

export class Logger {
  #engine: typeof ENGINE;
  #prefixs: string[];
  #context: Logger.Context;

  constructor() {
    this.#engine = ENGINE;
    this.#prefixs = [];
    this.#context = {};
  }

  #write(level: Logger.Level, message: string, context?: Logger.Context) {
    const prefix = this.#prefixs.length ? `[${this.#prefixs.join("::")}] ` : "";
    const bindings = { ...context, ...this.#context };

    this.#engine[level](bindings, `${prefix}${message}`);
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
    this.#engine.fatal(ErrorHelpers.as(error), message);
  }

  error(message: string, context?: Record<string, unknown>) {
    this.#write("error", message, context);
  }

  errorFrom(error: unknown, message?: string) {
    this.#engine.error(ErrorHelpers.as(error), message);
  }

  prefix(prefix: string, context?: Logger.Context) {
    const child = new Logger();

    child.#prefixs = [...this.#prefixs, prefix];
    child.#context = { ...context, ...this.#context };

    return child;
  }

  with(context: Logger.Context) {
    const child = new Logger();

    child.#prefixs = [...this.#prefixs];
    child.#context = { ...context, ...this.#context };

    return child;
  }

  flush() {
    this.#engine.flush();
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
