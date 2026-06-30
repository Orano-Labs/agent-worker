import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Environment } from "@/internal/environment";
import { GRPCServer } from "@/internal/grpc-server";
import { HTTPServer } from "@/internal/http-server";
import { Key } from "@/internal/key";
import { Logger } from "@/internal/logger";
import { MessageBroker } from "@/internal/message-broker";
import { MessageOutbox } from "@/internal/message-outbox";
import { MessageRelayer } from "@/internal/message-relayer";
import { Repository } from "@/internal/repository";
import { Variables } from "@/internal/variables";
import { ProjectServiceImplementation } from "@/services/project";
import { SupervisorServiceImplementation } from "@/services/supervisor";
import { UserServiceImplementation } from "@/services/user";

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

    const cli = Container.inject(CommandLine);

    this.#logger.info("Command line arguments", {
      cwd: cli.cwd,
      logLevel: cli.logLevel,
      logColorize: cli.logColorize,
      envFiles: cli.envFiles,
    });

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

    await Container.inject(MessageBroker)
      .init()
      .then((result) => {
        if (result.isErr()) {
          this.#logger.error("Failed to initialize message queue", {
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

    Container.inject(GRPCServer).setup();
  }
}

Container.singleton(Key, () => new Key());
Container.singleton(CommandLine, () => new CommandLine());
Container.singleton(Logger, () => new Logger());
Container.singleton(Environment, () => new Environment());
Container.singleton(Variables, () => new Variables());
Container.singleton(Repository, () => new Repository());

Container.singleton(HTTPServer, () => new HTTPServer());
Container.singleton(GRPCServer, () => new GRPCServer());

Container.singleton(Bootstrapper, () => new Bootstrapper());

Container.singleton(UserServiceImplementation, () => new UserServiceImplementation());
Container.singleton(SupervisorServiceImplementation, () => new SupervisorServiceImplementation());
Container.singleton(ProjectServiceImplementation, () => new ProjectServiceImplementation());

Container.singleton(MessageOutbox, () => new MessageOutbox());
Container.singleton(MessageRelayer, () => new MessageRelayer());
Container.singleton(MessageBroker, () => new MessageBroker());
