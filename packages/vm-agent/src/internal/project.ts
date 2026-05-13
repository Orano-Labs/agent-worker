import { exec } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { Container } from "@/helpers/container";
import { Environment } from "@/internal/environment";

export class Project {
  #status: Project.Status;

  #environment: Environment;

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

    this.#status = {
      type: "error",
      message: "Not initialized",
    };
  }

  async init() {
    if (!this.#environment.ready) {
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
      const ok = await mkdir(directory.path, { recursive: true }).then(
        () => true,
        () => false,
      );

      if (!ok) {
        this.#status = {
          type: "error",
          message: `Failed to create ${directory.description} dir`,
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
      console.log(command.command);
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
