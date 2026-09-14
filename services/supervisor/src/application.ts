import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { Dependencies } from "@/internal/dependencies";
import { Shell } from "@/internal/shell";
import { VMKernel } from "@/internal/vm-kernel";
import { VMNet } from "@/internal/vm-net";
import { Controller } from "./internal/controller";
import { Director } from "./internal/director";
import { Ganesha } from "./internal/ganesha";
import { KVStorage } from "./internal/kv-storage";
import { Tunnel } from "./internal/tunnel";
import { VMImage } from "./internal/vm-image";
import { VMManager } from "./internal/vm-manager";

const EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export class Application extends Container.ServiceConstructable {
  #logger: Logger;
  #environment: Environment;
  // #manager: VMManager;
  // #ganesha: Ganesha;

  #vm?: VMManager.VM.Resources & {
    running: Promise<void>;
    controller: AbortController;
    instance: VMManager.VM;
  };

  constructor(injector: Container.Injector) {
    super();

    this.#logger = injector.injectMust(Logger).namespace("Application");
    this.#environment = injector.injectMust(Environment);

    for (const warn of this.#environment.warnings) {
      this.#logger.namespace("Environment.Warnings").warn(warn);
    }

    // this.#manager = injector.injectMust(VMManager);
    // this.#ganesha = injector.injectMust(Ganesha);

    injector.injectMust(Director);
    injector.injectMust(Tunnel);
  }

  protected override async dispose(reason: unknown) {
    if (reason instanceof Application.TerminatedError) {
      this.#logger.info(`Shutting down: terminated by ${reason.signal}`);
    } else if (reason === undefined) {
      this.#logger.info("Shutting down: graceful exit");
    } else {
      this.#logger.warn(`Shutting down: unexpected reason ${JSON.stringify(String(reason))}`);
    }

    if (this.#vm) {
      this.#vm.controller.abort(reason);

      await this.#vm.running.catch(() => {});
    }
  }

  protected override async initialize(_: AbortSignal) {
    // fetch("http://117.55.235.4:3008/link/avo0z2l0htueeqk8clq57fn4/wx").then(console.log).catch(console.log)
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
    container.provide(Dependencies, (injector) => {
      return new Dependencies(injector.injectMust(Environment), injector.injectMust(Logger));
    });
    container.provide(VMNet, (injector) => {
      return new VMNet(injector.injectMust(Logger), injector.injectMust(Shell));
    });
    container.provide(VMKernel, (injector) => {
      return new VMKernel(injector.injectMust(Environment), injector.injectMust(Logger), injector.injectMust(Shell));
    });
    container.provide(VMImage, (injector) => {
      return new VMImage(
        injector.injectMust(Environment),
        injector.injectMust(Dependencies),
        injector.injectMust(Logger),
        injector.injectMust(Shell),
      );
    });
    container.provide(VMManager, (injector) => {
      return new VMManager(
        injector.injectMust(Environment),
        injector.injectMust(Logger),
        injector.injectMust(VMImage),
        injector.injectMust(VMKernel),
        injector.injectMust(VMNet),
        injector.injectMust(Dependencies),
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
        injector.injectMust(VMManager),
        injector.injectMust(Ganesha),
      );
    });
    container.provide(KVStorage, (injector) => {
      return new KVStorage(injector.injectMust(Logger), injector.injectMust(Environment));
    });
    container.provide(Tunnel, (injector) => {
      return new Tunnel(injector.injectMust(Environment), injector.injectMust(Logger), injector.injectMust(Controller));
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
