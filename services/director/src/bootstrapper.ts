import { Authenticator } from "@/core/services/authenticator";
import { SupervisorRegistry } from "@/core/services/supervisor-registry";
import { ExternalRouterHandler } from "@/external-router-handler";
import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Database } from "@/internal/database";
import { Environment } from "@/internal/environment";
import { Git } from "@/internal/git";
import { HTTPServer } from "@/internal/http-server";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";
import { InternalRouterHandler } from "@/internal-router-handler";

export class Bootstrapper {
  #logger: Logger;

  #shutting = false;

  async #shutdown(signal?: string) {
    if (this.#shutting) {
      return;
    }

    this.#shutting = true;

    this.#logger.info(`Received termination signal${signal ? `(${signal})` : ""}, shutting down...`);

    const http = Container.inject(HTTPServer);
    const logger = Container.inject(Logger);

    await http.shutdown();
    await logger.flush();
  }

  constructor() {
    this.#logger = Container.inject(Logger).scope("Bootstrapper");
  }

  async boot() {
    const cli = Container.inject(CommandLine);

    this.#logger.info("Command line arguments", {
      cwd: cli.cwd,
      logLevel: cli.logLevel,
      logColorize: cli.logColorize,
      envFiles: cli.envFiles,
    });
    this.#logger.info("Initializing...");

    process.once("SIGINT", () => {
      this.#shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      this.#shutdown("SIGTERM");
    });

    const variables = Container.inject(Variables);
    const environment = Container.inject(Environment);
    const db = Container.inject(Database);
    const git = Container.inject(Git);
    const http = Container.inject(HTTPServer);

    for (const initializable of [variables, environment, db, git, http]) {
      await initializable.init();

      if ("ready" in initializable && !initializable.ready) {
        process.exit(1);
      }
    }

    Container.inject(ExternalRouterHandler).setup();
    Container.inject(InternalRouterHandler).setup();
  }
}

Container.singleton(CommandLine, () => new CommandLine());
Container.singleton(Logger, () => new Logger());
Container.singleton(Environment, () => new Environment());
Container.singleton(Variables, () => new Variables());
Container.singleton(Database, () => new Database());
Container.singleton(Git, () => new Git());
Container.singleton(HTTPServer, () => new HTTPServer());

Container.singleton(Authenticator, () => new Authenticator());
Container.singleton(SupervisorRegistry, () => new SupervisorRegistry());

Container.singleton(ExternalRouterHandler, () => new ExternalRouterHandler());
Container.singleton(InternalRouterHandler, () => new InternalRouterHandler());
Container.singleton(Bootstrapper, () => new Bootstrapper());
