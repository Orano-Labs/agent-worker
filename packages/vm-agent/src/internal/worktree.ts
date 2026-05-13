import { exec } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { Container } from "@/helpers/container";
import { Environment } from "@/internal/environment";
import { Project } from "@/internal/project";

export class Worktree {
  #status: Worktree.Status;

  #environment: Environment;
  #project: Project;

  get status() {
    return this.#status;
  }

  get ready() {
    return this.#status.type === "ready";
  }

  constructor() {
    this.#environment = Container.inject(Environment);
    this.#project = Container.inject(Project);

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
    if (!this.#project.ready) {
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
      const ok = await promisify(exec)(command.command, { cwd: command.cwd }).then(
        () => true,
        () => false,
      );

      if (!ok) {
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
