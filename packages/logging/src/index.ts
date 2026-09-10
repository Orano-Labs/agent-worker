import { AsyncLocalStorage } from "node:async_hooks";
import { Container } from "@aw/container";
import { default as pino } from "pino";
import { default as pinoPretty } from "pino-pretty";

export class Logger extends Container.ServiceConstructable {
  #namespace: string[];
  #bindings: Record<string, unknown>;

  #engine?: Logger.Engine;

  constructor(engine?: Logger.Engine) {
    super();

    this.#namespace = [];
    this.#bindings = {};
    this.#engine = engine;
  }

  trace(message: string, bindings?: Record<string, unknown>) {
    this.#write(Logger.Level.Trace, message, bindings);
  }

  debug(message: string, bindings?: Record<string, unknown>) {
    this.#write(Logger.Level.Debug, message, bindings);
  }

  info(message: string, bindings?: Record<string, unknown>) {
    this.#write(Logger.Level.Info, message, bindings);
  }

  warn(message: string, bindings?: Record<string, unknown>) {
    this.#write(Logger.Level.Warn, message, bindings);
  }

  error(message: string, bindings?: Record<string, unknown>) {
    this.#write(Logger.Level.Error, message, bindings);
  }

  fatal(message: string, bindings?: Record<string, unknown>) {
    this.#write(Logger.Level.Fatal, message, bindings);
  }

  namespace(namespace: string, bindings?: Record<string, unknown>) {
    return this.#child([...this.#namespace, namespace], { ...this.#bindings, ...bindings });
  }

  binding(bindings: Record<string, unknown>) {
    return this.#child(this.#namespace, { ...this.#bindings, ...bindings });
  }

  #child(namespace: string[], bindings: Record<string, unknown>) {
    const child = new Logger(this.#engine);

    child.#namespace = namespace;
    child.#bindings = bindings;

    return child;
  }

  #write(level: Logger.Level, message: string, bindings?: Record<string, unknown>) {
    const context = Logger.#asyncContextStorage.getStore() || {};
    const threshold = context.threshold ?? Logger.Level.Trace;

    if (level < threshold) {
      return;
    }

    this.#engine?.write(level, this.#namespace, message, {
      ...context.bindings,
      ...this.#bindings,
      ...bindings,
    });
  }

  #merge(context: Logger.AsyncContext) {
    const current = Logger.#asyncContextStorage.getStore() || {};

    return {
      ...current,
      ...context,
      bindings: { ...current.bindings, ...context.bindings },
    } satisfies Logger.AsyncContext as Logger.AsyncContext;
  }

  async withBindings<T>(bindings: Record<string, unknown>, callback: () => T) {
    return Logger.#asyncContextStorage.run(this.#merge({ bindings }), callback);
  }

  async withThreshold<T>(level: Logger.Level, callback: () => T) {
    return Logger.#asyncContextStorage.run(this.#merge({ threshold: level }), callback);
  }

  async withContext<T>(context: Logger.AsyncContext, callback: () => T) {
    return Logger.#asyncContextStorage.run(this.#merge(context), callback);
  }

  static #asyncContextStorage = new AsyncLocalStorage<Logger.AsyncContext>();
}

export namespace Logger {
  export enum Level {
    Trace = 0,
    Debug = 1,

    Info = 2,
    Warn = 3,

    Fatal = 4,
    Error = 5,
  }

  export type AsyncContext = {
    threshold?: Level;
    bindings?: Record<string, unknown>;
  };

  export abstract class Engine extends Container.ServiceConstructable {
    abstract write(level: Level, namespace: string[], message: string, bindings: Record<string, unknown>): void;
  }

  export class PinoEngine extends Engine {
    #instance: ReturnType<typeof pino>;

    constructor(pretty?: boolean) {
      super();

      if (pretty) {
        this.#instance = pino(
          pinoPretty({
            customPrettifiers: {
              level: (_data, _key, _log, extra) => {
                return extra.labelColorized.replace(extra.label, extra.label.padEnd(5));
              },
            },
          }),
        );
        this.#instance.level = "trace";
      } else {
        this.#instance = pino({
          base: null,
          messageKey: "message",
        });
      }
    }

    write(level: Level, namespace: string[], message: string, bindings: Record<string, unknown>) {
      this.#instance[PinoEngine.#mapLevel[level]](bindings, `[${namespace.join("::")}] ${message}`);
    }

    override async dispose() {
      return new Promise<void>((resolve, reject) => {
        this.#instance.flush((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }

    static #mapLevel: Record<Level, string> = {
      [Level.Trace]: "trace",
      [Level.Debug]: "debug",
      [Level.Info]: "info",
      [Level.Warn]: "warn",
      [Level.Error]: "error",
      [Level.Fatal]: "fatal",
    };
  }
}
