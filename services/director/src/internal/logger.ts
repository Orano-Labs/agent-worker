import { default as pino } from "pino";
import { default as pretty } from "pino-pretty";

import { Container } from "@/helpers/container";
import { ErrorHelpers } from "@/helpers/error-helpers";
import { CommandLine } from "@/internal/command-line";

const PRODUCTION = process.env.NODE_ENV === "production";

export class Logger {
  #logger: ReturnType<typeof pino>;

  #cli: CommandLine;

  constructor(options?: Logger.Options) {
    this.#cli = Container.inject(CommandLine);

    if (options?.parent) {
      this.#logger = options.parent.#logger.child(options.context || {}, {
        msgPrefix: options.scope ? `[${options.scope}] ` : undefined,
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

      if (this.#cli.logLevel && ["fatal", "error", "warn", "info", "debug", "trace", "silent"].includes(this.#cli.logLevel)) {
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

  mask(text: string, options?: Logger.MaskOptions): string {
    const opts = {
      maxLength: options?.maxLength ?? 20,
      visibleChars: options?.visibleChars ?? 2,
      pattern: options?.pattern,
    };

    // 如果提供了自定义模式，使用正则表达式进行替换
    if (opts.pattern) {
      return text.replace(opts.pattern, (match) => {
        if (match.length <= opts.visibleChars * 2) {
          return "*".repeat(match.length);
        }

        const start = match.slice(0, opts.visibleChars);
        const end = match.slice(-opts.visibleChars);
        const middle = "*".repeat(Math.max(0, match.length - opts.visibleChars * 2));

        return `${start}${middle}${end}`;
      });
    }

    // 默认脱敏策略：保留开头和结尾的字符，中间用掩码字符替换
    if (text.length <= opts.maxLength) {
      if (text.length <= opts.visibleChars * 2) {
        return "*".repeat(text.length);
      }

      const start = text.slice(0, opts.visibleChars);
      const end = text.slice(-opts.visibleChars);
      const middle = "*".repeat(text.length - opts.visibleChars * 2);

      return `${start}${middle}${end}`;
    }

    // 对于较长的文本，截断并脱敏
    const truncated = text.slice(0, opts.maxLength);
    const start = truncated.slice(0, opts.visibleChars);
    const end = truncated.slice(-opts.visibleChars);
    const middle = "*".repeat(truncated.length - opts.visibleChars * 2);

    return `${start}${middle}${end}...`;
  }

  async flush() {
    return new Promise<void>((resolve, reject) => {
      this.#logger.flush((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

export namespace Logger {
  export type Context = Record<string, unknown>;

  export type Engine = ReturnType<typeof pino>;

  export type Level = "info" | "debug" | "warn" | "trace" | "fatal" | "error";

  export type MaskOptions = {
    /** 最大显示长度，默认 20 */
    maxLength?: number;
    /** 可见字符数（开头和结尾各保留多少个字符），默认 4 */
    visibleChars?: number;
    /** 自定义正则表达式模式，用于匹配需要脱敏的内容 */
    pattern?: RegExp;
  };

  export type Options = {
    parent?: Logger;
    context?: Context;
    scope?: string;
  };
}
