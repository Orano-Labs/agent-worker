import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { FileSystemServiceImplementation } from "@/api/grpc/file-system";
import { FileUploadServiceImplementation } from "@/api/grpc/file-upload";
import { ProjectServiceImplementation } from "@/api/grpc/project";
import { SupervisorServiceImplementation } from "@/api/grpc/supervisor";
import { SupervisorPortalServiceImplementation } from "@/api/grpc/supervisor-portal";
import { TemplateServiceImplementation } from "@/api/grpc/template";
import { UserServiceImplementation } from "@/api/grpc/user";
import { GRPCHandler } from "@/api/grpc-handler";
import { Allocator } from "@/internal/allocator";
import { Authenticator } from "@/internal/authenticator";
import { Cache } from "@/internal/cache";
import { HTTPServer } from "@/internal/http-server";
import { Key } from "@/internal/key";
import { Leases } from "@/internal/leases";
import { Repository } from "@/internal/repository";
import { TunnelIngress } from "./api/tunnel-ingress";

const EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export class Application extends Container.ServiceConstructable {
  #logger: Logger;
  #environment: Environment;

  constructor(injector: Container.Injector) {
    super();

    this.#logger = injector.injectMust(Logger).namespace("Application");
    this.#environment = injector.injectMust(Environment);

    for (const warn of this.#environment.warnings) {
      this.#logger.namespace("Environment.Warnings").warn(warn);
    }

    injector.injectMust(TunnelIngress);
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
    container.provide(Key, () => {
      return new Key();
    });
    container.provide(Repository, (injector) => {
      return new Repository(injector.injectMust(Environment), injector.injectMust(Logger));
    });
    container.provide(Cache, (injector) => {
      return new Cache(injector.injectMust(Environment));
    });
    container.provide(Authenticator, (injector) => {
      return new Authenticator(
        injector.injectMust(Environment),
        injector.injectMust(Logger),
        injector.injectMust(Key),
        injector.injectMust(Repository),
        injector.injectMust(Cache),
      );
    });
    container.provide(Allocator, (injector) => {
      return new Allocator(injector.injectMust(Logger), injector.injectMust(Repository), injector.injectMust(Leases));
    });
    container.provide(Leases, (injector) => {
      return new Leases(injector.injectMust(Logger));
    });
    container.provide(HTTPServer, (injector) => {
      return new HTTPServer(injector.injectMust(Environment), injector.injectMust(Logger));
    });
    container.provide(GRPCHandler, (injector) => {
      return new GRPCHandler(
        injector.injectMust(Logger),
        injector.injectMust(Authenticator),
        injector.injectAny(GRPCHandler.ServiceImplementation),
      );
    });
    container.provide(UserServiceImplementation, (injector) => {
      return new UserServiceImplementation(injector.injectMust(Repository), injector.injectMust(Key));
    });
    container.provide(SupervisorServiceImplementation, (injector) => {
      return new SupervisorServiceImplementation(injector.injectMust(Repository), injector.injectMust(Key), injector.injectMust(Allocator));
    });
    container.provide(SupervisorPortalServiceImplementation, (injector) => {
      return new SupervisorPortalServiceImplementation(
        injector.injectMust(Allocator),
        injector.injectMust(Logger),
        injector.injectMust(Repository),
        injector.injectMust(Leases),
      );
    });
    container.provide(ProjectServiceImplementation, (injector) => {
      return new ProjectServiceImplementation(
        injector.injectMust(Repository),
        injector.injectMust(Environment),
        injector.injectMust(Logger),
        injector.injectMust(Allocator),
      );
    });
    container.provide(TemplateServiceImplementation, (injector) => {
      return new TemplateServiceImplementation(
        injector.injectMust(Repository),
        injector.injectMust(Environment),
        injector.injectMust(Logger),
      );
    });
    container.provide(FileSystemServiceImplementation, (injector) => {
      return new FileSystemServiceImplementation(
        injector.injectMust(Repository),
        injector.injectMust(Environment),
        injector.injectMust(Logger),
      );
    });
    container.provide(FileUploadServiceImplementation, (injector) => {
      return new FileUploadServiceImplementation(
        injector.injectMust(Repository),
        injector.injectMust(Environment),
        injector.injectMust(Logger),
      );
    });
    container.provide(TunnelIngress, (injector) => {
      return new TunnelIngress(
        injector.injectMust(Authenticator),
        injector.injectMust(Logger),
        injector.injectMust(HTTPServer),
        injector.injectMust(Leases),
      );
    });

    const environment = new Environment({ prefix: "AW_DIRECTOR", root: process.cwd() });

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
