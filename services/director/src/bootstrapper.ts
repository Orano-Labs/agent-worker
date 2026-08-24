import { Container } from "@/helpers/container";
import { Authenticator } from "@/internal/authenticator";
import { Cache } from "@/internal/cache";
import { Environment } from "@/internal/environment";
import { GRPCServer } from "@/internal/grpc-server";
import { HTTPServer } from "@/internal/http-server";
import { HTTPServerRouter } from "@/internal/http-server-router";
import { Key } from "@/internal/key";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";
import { Variables } from "@/internal/variables";
import { ProjectServiceImplementation } from "@/services/project";
import { SupervisorServiceImplementation } from "@/services/supervisor";
import { SupervisorPortalServiceImplementation } from "@/services/supervisor-portal";
import { TemplateServiceImplementation } from "@/services/template";
import { UserServiceImplementation } from "@/services/user";
import { Allocator } from "./internal/allocator";

const PRODUCTION = process.env.NODE_ENV === "production";

export class Bootstrapper {
  #logger: Logger;

  #shutting = false;
  #controller: AbortController;

  async #shutdown(signal?: string) {
    if (this.#shutting) {
      return;
    }

    this.#shutting = true;

    this.#logger.info(`Received termination signal${signal ? `(${signal})` : ""}, shutting down...`);
    this.#controller.abort(new Error("Termination signal received"));

    const http = Container.inject(HTTPServer);
    const logger = Container.inject(Logger);

    await http.shutdown();
    await logger.flush();
  }

  constructor() {
    this.#logger = Container.inject(Logger).scope("Bootstrapper");
    this.#controller = new AbortController();
  }

  async boot() {
    if (!PRODUCTION) {
      this.#logger.warn("Running in development mode, this is not recommended for production use.");
    }

    process.once("SIGINT", () => {
      this.#shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      this.#shutdown("SIGTERM");
    });

    await Container.inject(Variables)
      .init()
      .then((result) => {
        if (result.isErr()) {
          this.#logger.error("Failed to initialize variables", {
            err: result.error,
          });

          process.exit(1);
        }
      });

    await Container.inject(Environment)
      .init()
      .then((result) => {
        if (result.isErr()) {
          this.#logger.error("Failed to initialize environment", {
            err: result.error,
          });

          process.exit(1);
        }
      });

    await Container.inject(Repository)
      .init()
      .then((result) => {
        if (result.isErr()) {
          this.#logger.error("Failed to initialize repository", {
            err: result.error,
          });

          process.exit(1);
        }
      });

    await Container.inject(Allocator)
      .init()
      .then((result) => {
        if (result.isErr()) {
          this.#logger.error("Failed to initialize allocator", {
            err: result.error,
          });

          process.exit(1);
        }
      });

    await Container.inject(Cache)
      .init()
      .then((result) => {
        if (result.isErr()) {
          this.#logger.error("Failed to initialize redis cache", {
            err: result.error,
          });

          process.exit(1);
        }
      });

    await Container.inject(HTTPServer)
      .init()
      .then((result) => {
        if (result.isErr()) {
          this.#logger.error("Failed to initialize HTTP server", {
            err: result.error,
          });

          process.exit(1);
        }
      });

    await Container.inject(GRPCServer)
      .init()
      .then((result) => {
        if (result.isErr()) {
          this.#logger.error("Failed to initialize GRPC server", {
            err: result.error,
          });

          process.exit(1);
        }
      });

    Container.inject(HTTPServerRouter).setup();
  }
}

Container.singleton(Key, () => new Key());
Container.singleton(Logger, () => new Logger());
Container.singleton(Environment, () => new Environment());
Container.singleton(Variables, () => new Variables());
Container.singleton(Repository, () => new Repository());
Container.singleton(Cache, () => new Cache());

Container.singleton(Allocator, () => new Allocator());
Container.singleton(Authenticator, () => new Authenticator());

Container.singleton(HTTPServer, () => new HTTPServer());
Container.singleton(GRPCServer, () => new GRPCServer());
Container.singleton(HTTPServerRouter, () => new HTTPServerRouter());

Container.singleton(Bootstrapper, () => new Bootstrapper());

Container.singleton(UserServiceImplementation, () => new UserServiceImplementation());
Container.singleton(SupervisorServiceImplementation, () => new SupervisorServiceImplementation());
Container.singleton(SupervisorPortalServiceImplementation, () => new SupervisorPortalServiceImplementation());
Container.singleton(ProjectServiceImplementation, () => new ProjectServiceImplementation());
Container.singleton(TemplateServiceImplementation, () => new TemplateServiceImplementation());
