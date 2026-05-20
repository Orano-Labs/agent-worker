import { API } from "@/api";
import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Database } from "@/internal/database";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";
import { Project } from "@/internal/project";
import { Server } from "@/internal/server";
import { Tunnel } from "@/internal/tunnel";
import { Variables } from "@/internal/variables";
import { Worktree } from "@/internal/worktree";

export class Bootstrapper {
  #logger: Logger;

  #shutting = false;

  async #shutdown(signal?: string) {
    if (this.#shutting) {
      return;
    }

    this.#shutting = true;

    this.#logger.info(`Received termination signal${signal ? `(${signal})` : ""}, shutting down...`);

    const server = Container.inject(Server);
    const tunnel = Container.inject(Tunnel);

    await tunnel.shutdown().catch((error) => {
      this.#logger.errorFrom(error, "Failed to shutdown tunnel");
    });
    await server.shutdown().catch((error) => {
      this.#logger.errorFrom(error, "Failed to shutdown server");
    });
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

    try {
      const environment = Container.inject(Environment);
      const project = Container.inject(Project);
      const worktree = Container.inject(Worktree);
      const variables = Container.inject(Variables);
      const db = Container.inject(Database);
      const server = Container.inject(Server);
      const tunnel = Container.inject(Tunnel);
      const api = Container.inject(API);

      await variables.init();
      await environment.init();
      await db.init();
      await project.init();
      await worktree.init();
      await server.init({
        onConnection: (socket) => {
          const connection = api.connect(socket);

          connection
            .invoke("vm-agent.fs/list", {
              data: {
                context: {
                  type: "main",
                },
                path: "xxx",
              },
              metadata: {},
            })
            .then(console.log, console.log);
        },
      });
      await tunnel.init({
        onConnect: (socket) => {
          api.connect(socket);
        },
      });
    } catch (error) {
      this.#logger.errorFrom(error, "Failed to initialize");
    }
  }
}

Container.singleton(CommandLine, () => new CommandLine());
Container.singleton(Logger, () => new Logger());
Container.singleton(Environment, () => new Environment());
Container.singleton(Project, () => new Project());
Container.singleton(Worktree, () => new Worktree());
Container.singleton(Variables, () => new Variables());
Container.singleton(Database, () => new Database());
Container.singleton(Server, () => new Server());
Container.singleton(Tunnel, () => new Tunnel());
Container.singleton(Bootstrapper, () => new Bootstrapper());
Container.singleton(API, () => new API());
