import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { Controller } from "@/internal/controller";
import { Director } from "@/internal/director";
import { Ganesha } from "@/internal/ganesha";
import { KVStorage } from "@/internal/kv-storage";
import { RPC } from "@/internal/rpc";
import { Shell } from "@/internal/shell";
import { Tunnel } from "@/internal/tunnel";
import { VMFactory } from "@/internal/vm-factory";
import { VMImage } from "@/internal/vm-image";
import { VMNet } from "@/internal/vm-net";
import { Server } from "./internal/server";

const EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export class Application extends Container.ServiceConstructable {
  #logger: Logger;
  #environment: Environment;
  #factory: VMFactory;

  constructor(injector: Container.Injector) {
    super();

    this.#logger = injector.injectMust(Logger).namespace("Application");
    this.#environment = injector.injectMust(Environment);

    for (const message of this.#environment.messages) {
      this.#logger.namespace("Environment.Messages").info(message);
    }

    for (const warn of this.#environment.warnings) {
      this.#logger.namespace("Environment.Warnings").warn(warn);
    }

    // injector.injectMust(Tunnel);
    //

    this.#factory = injector.injectMust(VMFactory);
  }

  protected override async dispose(reason: unknown) {
    if (reason instanceof Application.TerminatedError) {
      this.#logger.info(`Shutting down: terminated by ${reason.signal}`);
    } else if (reason === undefined) {
      this.#logger.info("Shutting down: graceful exit");
    } else {
      this.#logger.warn(`Shutting down: unexpected reason ${JSON.stringify(String(reason))}`);
    }
  }

  protected override async initialize(s: AbortSignal) {
    await this.#factory
      .create({
        id: Math.random().toString().slice(2, 8),
        machineTier: "minimal",
      })
      .run(s, async () => {});
  }

  static async run() {
    const controller = new AbortController();
    const container = new Container(Application, (injector) => {
      return new Application(injector);
    });

    container.provide(Logger, (injector) => {
      return new Logger(injector.injectMust(Logger.Engine));
    });
    container.provide(Logger.Engine, () => {
      return new Logger.PinoEngine(environment.mode !== Environment.Mode.Production);
    });
    container.provide(VMNet, (injector) => {
      return new VMNet(injector.injectMust(Logger), injector.injectMust(Shell));
    });
    container.provide(VMImage, (injector) => {
      return new VMImage(injector.injectMust(Environment), injector.injectMust(Logger), injector.injectMust(Shell));
    });
    container.provide(VMFactory, (injector) => {
      return new VMFactory(
        injector.injectMust(Environment),
        injector.injectMust(Logger),
        injector.injectMust(VMImage),
        injector.injectMust(VMNet),
      );
    });
    container.provide(Shell, () => {
      return new Shell();
    });
    container.provide(Ganesha, (injector) => {
      return new Ganesha(injector.injectMust(Environment), injector.injectMust(Logger));
    });
    container.provide(Director, (injector) => {
      return new Director(injector.injectMust(Environment), injector.injectMust(Logger));
    });
    container.provide(Controller, (injector) => {
      return new Controller(
        injector.injectMust(Environment),
        injector.injectMust(Logger),
        injector.injectMust(KVStorage),
        injector.injectMust(Director),
        injector.injectMust(VMFactory),
        injector.injectMust(Ganesha),
      );
    });
    container.provide(KVStorage, (injector) => {
      return new KVStorage(injector.injectMust(Environment));
    });
    container.provide(Tunnel, (injector) => {
      return new Tunnel(injector.injectMust(Environment), injector.injectMust(Logger), injector.injectMust(Controller));
    });
    container.provide(Server, (injector) => {
      return new Server(injector.injectMust(Environment), injector.injectMust(Logger));
    });
    container.provide(RPC, (injector) => {
      return new RPC(injector.injectMust(Server), injector.injectMust(Logger));
    });

    const environment = new Environment({ prefix: "AW_SUPERVISOR", root: "/aw-supervisor" });

    container.provide(Environment, () => environment);
    container.resolve();

    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.once(sig, (signal) => {
        controller.abort(new Application.TerminatedError(signal));
      });
    }

    try {
      const ctrl = new AbortController();
      const abort = ctrl.abort.bind(ctrl);

      controller.signal.addEventListener("abort", abort);

      await container.initialize(ctrl.signal).finally(() => {
        controller.signal.removeEventListener("abort", abort);
      });
    } catch (error) {
      if (error instanceof Application.TerminatedError) {
        console.log(`\n\nInitialization terminated by ${error.signal} .... \n\n`);
        process.exit(EXIT_CODES[error.signal] ?? 0);
      }

      throw error;
    }

    await new Promise<void>((resolve) => {
      const keepalive = setInterval(() => {}, 1 << 30);

      controller.signal.addEventListener("abort", () => {
        keepalive.close();
        resolve();
      });
    });

    await container.dispose(controller.signal.reason);

    if (controller.signal.reason instanceof Application.TerminatedError) {
      process.exit(EXIT_CODES[controller.signal.reason.signal] ?? 0);
    }

    process.exit(0);
  }
}

export namespace Application {
  export class TerminatedError extends Error {
    #signal: NodeJS.Signals;

    get name() {
      return "AbortError";
    }

    get signal() {
      return this.#signal;
    }

    get message() {
      return `Terminated by ${this.signal}`;
    }

    constructor(signal: NodeJS.Signals) {
      super();

      this.#signal = signal;
    }
  }
}
