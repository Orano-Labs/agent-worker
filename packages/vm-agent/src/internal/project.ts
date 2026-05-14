import { exec } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { Container } from "@/helpers/container";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";

export class Project {
  #status: Project.Status;

  #environment: Environment;
  #logger: Logger;

  get status() {
    return this.#status;
  }

  get ready() {
    return this.#status.type === "ready";
  }

  get repository() {
    return join(this.#environment.workdir, "repository.git");
  }

  get worktrees() {
    return join(this.#environment.workdir, "worktrees");
  }

  constructor() {
    this.#environment = Container.inject(Environment);
    this.#logger = Container.inject(Logger).scope("Project");

    this.#status = {
      type: "error",
      message: "Not initialized",
    };
  }

  async init() {
    this.#logger.info("Initializing...");

    if (!this.#environment.ready) {
      this.#logger.error("Environment not ready, skipping project initialization");

      this.#status = {
        type: "error",
        message: "Environment not ready",
      };

      return;
    }

    const directories = [
      {
        path: this.repository,
        description: "repository",
      },
      {
        path: this.worktrees,
        description: "worktrees",
      },
      {
        path: join(this.worktrees, "main"),
        description: "main worktree",
      },
      {
        path: join(this.worktrees, "sessions"),
        description: "sessions worktree",
      },
    ];

    for (const directory of directories) {
      try {
        await mkdir(directory.path, { recursive: true });
      } catch (error) {
        this.#logger.errorFrom(error, `Failed to create ${directory.description} directory`);

        this.#status = {
          type: "error",
          message: `Failed to create ${directory.description} directory`,
        };

        return;
      }
    }

    const commands = [
      {
        command: `git init --bare ${this.repository}`,
        description: "initialize bare repository",
        cwd: this.#environment.workdir,
      },
      {
        command: `git clone ${this.repository} .bootstrap`,
        description: "bootstrap repository",
        cwd: this.#environment.workdir,
      },
      {
        command: "git checkout -b main",
        description: "create main branch",
        cwd: `${this.#environment.workdir}/.bootstrap`,
      },
      {
        command: "git commit --allow-empty -m 'Initial commit'",
        description: "initial commit",
        cwd: `${this.#environment.workdir}/.bootstrap`,
      },
      {
        command: "git push -u origin main",
        description: "push main branch",
        cwd: `${this.#environment.workdir}/.bootstrap`,
      },
      {
        command: "rm -rf bootstrap",
        description: "cleanup bootstrap",
        cwd: this.#environment.workdir,
      },
    ];

    for (const command of commands) {
      try {
        await promisify(exec)(command.command, { cwd: command.cwd });
      } catch (error) {
        this.#logger.errorFrom(error, `Failed to ${command.description}`);

        this.#status = {
          type: "error",
          message: `Failed to ${command.description}.`,
        };

        return;
      }
    }

    this.#status = {
      type: "ready",
    };

    this.#logger.info("Initialized");
  }
}

export namespace Project {
  export type Status =
    | {
        type: "ready";
      }
    | {
        type: "error";
        message: string;
      };
}
