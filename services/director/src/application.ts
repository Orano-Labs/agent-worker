import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { FileSystemServiceImpl } from "@/api/grpc/file-system-service";
import { ProjectServiceImpl } from "@/api/grpc/project-service";
import { SupervisorServiceImpl } from "@/api/grpc/supervisor-service";
import { TemplateServiceImpl } from "@/api/grpc/template-service";
import { UserServiceImpl } from "@/api/grpc/user-service";
import { SupervisorTunnelService } from "@/api/tunnel-service";
import { Signature, SignatureIdentity } from "@/generated/proto/api/v1/signature";
import { Authenticator } from "@/internal/authenticator";
import { Cache } from "@/internal/cache";
import { Database } from "@/internal/database";
import { FileSystem } from "@/internal/file-system";
import { GRPCHandler } from "@/internal/grpc-handler";
import { HTTPServer } from "@/internal/http-server";
import { Projects } from "@/internal/projects";
import { Redis } from "@/internal/redis";
import { Supervisors } from "@/internal/supervisors";
import { Templates } from "@/internal/templates";
import { Tunnels } from "@/internal/tunnels";
import { Users } from "@/internal/users";

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

    injector.injectMust(GRPCHandler);

    for (const message of this.#environment.messages) {
      this.#logger.namespace("Environment.Messages").info(message);
    }

    for (const warn of this.#environment.warnings) {
      this.#logger.namespace("Environment.Warnings").warn(warn);
    }
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

    container.provide(Environment, () => {
      return new Environment({ prefix: "AW_DIRECTOR" });
    });
    container.provide(Logger.Engine, (injector) => {
      return new Logger.PinoEngine(injector.injectMust(Environment).mode !== Environment.Mode.Production);
    });
    container.provide(Logger, (injector) => {
      return new Logger(injector.injectMust(Logger.Engine));
    });
    container.provide(Database, (injector) => {
      return new Database(injector.injectMust(Environment), injector.injectMust(Logger));
    });
    container.provide(Redis, (injector) => {
      return new Redis(injector.injectMust(Environment), injector.injectMust(Logger));
    });
    container.provide(Cache, (injector) => {
      return new Cache(injector.injectMust(Environment), injector.injectMust(Logger), injector.injectMust(Redis));
    });
    container.provide(Users, (injector) => {
      return new Users(injector.injectMust(Database), injector.injectMust(Logger));
    });
    container.provide(Supervisors, (injector) => {
      return new Supervisors(injector.injectMust(Database), injector.injectMust(Logger));
    });
    container.provide(Templates, (injector) => {
      return new Templates(injector.injectMust(Database), injector.injectMust(Logger));
    });
    container.provide(FileSystem, (injector) => {
      return new FileSystem(injector.injectMust(Environment));
    });
    container.provide(Projects, (injector) => {
      return new Projects(injector.injectMust(Database), injector.injectMust(Logger));
    });
    container.provide(Authenticator, (injector) => {
      const toIdentity = (identity: SignatureIdentity["identity"]) => {
        switch (identity.case) {
          case "user":
            return { type: "user", id: identity.value.id } satisfies Authenticator.Identity;
          case "manager":
            return { type: "manager" } satisfies Authenticator.Identity;
          case "supervisor":
            return { type: "supervisor", id: identity.value.id } satisfies Authenticator.Identity;
          default:
            throw new Error("Unknown signature identity.");
        }
      };

      const codec: Authenticator.Codec = {
        decodeIdentity(buffer: Uint8Array) {
          return toIdentity(SignatureIdentity.fromBinary(buffer).identity);
        },

        decodeSignature(buffer: Uint8Array) {
          const { payload, signature } = Signature.fromBinary(buffer);

          return {
            nonce: payload.nonce,
            timestamp: payload.timestamp,
            identity: toIdentity(payload.identity.identity),
            signature,
          };
        },
      };

      return new Authenticator(
        codec,
        injector.injectMust(Environment),
        injector.injectMust(Logger),
        injector.injectMust(Redis),
        injector.injectMust(Users),
        injector.injectMust(Supervisors),
      );
    });
    container.provide(UserServiceImpl, (injector) => {
      return new UserServiceImpl(injector.injectMust(Authenticator), injector.injectMust(Users), injector.injectMust(Logger));
    });
    container.provide(SupervisorServiceImpl, (injector) => {
      return new SupervisorServiceImpl(injector.injectMust(Authenticator), injector.injectMust(Supervisors), injector.injectMust(Logger));
    });
    container.provide(TemplateServiceImpl, (injector) => {
      return new TemplateServiceImpl(
        injector.injectMust(Authenticator),
        injector.injectMust(Templates),
        injector.injectMust(FileSystem),
        injector.injectMust(Logger),
      );
    });
    container.provide(ProjectServiceImpl, (injector) => {
      return new ProjectServiceImpl(
        injector.injectMust(Authenticator),
        injector.injectMust(Projects),
        injector.injectMust(Templates),
        injector.injectMust(FileSystem),
        injector.injectMust(Logger),
      );
    });
    container.provide(FileSystemServiceImpl, (injector) => {
      return new FileSystemServiceImpl(
        injector.injectMust(Authenticator),
        injector.injectMust(Environment),
        injector.injectMust(Projects),
        injector.injectMust(Templates),
        injector.injectMust(Logger),
      );
    });
    container.provide(GRPCHandler, (injector) => {
      return new GRPCHandler(injector.injectMust(HTTPServer), injector.injectMust(Logger), injector.injectAny(GRPCHandler.Service));
    });
    container.provide(HTTPServer, (injector) => {
      return new HTTPServer(injector.injectMust(Environment), injector.injectMust(Logger));
    });
    container.provide(Tunnels, (injector) => {
      return new Tunnels(injector.injectMust(Logger));
    });
    container.provide(SupervisorTunnelService, (injector) => {
      return new SupervisorTunnelService(
        injector.injectMust(HTTPServer),
        injector.injectMust(Authenticator),
        injector.injectMust(Tunnels),
        injector.injectMust(Logger),
      );
    });

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
