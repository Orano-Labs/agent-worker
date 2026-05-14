import { exec } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { Container } from "@/helpers/container";
import { ErrorHelpers } from "@/helpers/error-helpers";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";
import { Project } from "@/internal/project";

export class Worktree {
  #status: Worktree.Status;

  #environment: Environment;
  #project: Project;
  #logger: Logger;

  get status() {
    return this.#status;
  }

  get ready() {
    return this.#status.type === "ready";
  }

  constructor() {
    this.#environment = Container.inject(Environment);
    this.#project = Container.inject(Project);
    this.#logger = Container.inject(Logger).scope("Worktree");

    this.#status = {
      type: "error",
      message: "Not initialized",
    };
  }

  resolve(type: "main"): string;
  resolve(type: "session", id: string): string;
  resolve(...args: ["main"] | ["session", string]) {
    if (args[0] === "main") {
      return join(this.#project.worktrees, "main");
    }

    return join(this.#project.worktrees, "sessions", args[1]);
  }

  async init() {
    this.#logger.info("Initializing...");

    if (!this.#project.ready) {
      this.#logger.error("Project not ready, skipping worktree initialization");

      this.#status = {
        type: "error",
        message: "Project not ready",
      };

      return;
    }

    const commands = [
      {
        command: `git --git-dir=${this.#project.repository} worktree add ${this.resolve("main")} main`,
        description: "create main worktree",
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

  async create(id: string) {
    if (!this.ready) {
      throw new Error("Worktree not ready, cannot create session worktree");
    }

    const dir = this.resolve("session", id);

    this.#logger.debug(`Creating session worktree for ID: ${id}`);

    try {
      // Create a new branch for this session based on main
      const branch = `session/${id}`;

      // Add worktree with new branch from main
      await promisify(exec)(`git --git-dir=${this.#project.repository} worktree add -b ${branch} ${dir} main`, {
        cwd: this.#environment.workdir,
      });

      this.#logger.debug(`Session worktree created successfully at ${dir}`);
    } catch (error) {
      throw new Error(`Failed to create session worktree: ${ErrorHelpers.as(error).message}`);
    }
  }
}

export namespace Worktree {
  export type Status =
    | {
        type: "error";
        message: string;
      }
    | {
        type: "ready";
      };
}
