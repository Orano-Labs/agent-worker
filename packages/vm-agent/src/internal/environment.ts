import { exec } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

declare const VERSION: string;

export class Environment {
  #status: Environment.Status;

  get platform() {
    return platform();
  }

  get arch() {
    return arch();
  }

  get ready() {
    return this.#status.type === "ready";
  }

  get workdir() {
    return join(homedir(), ".agent-worker");
  }

  get status() {
    return this.#status;
  }

  get version() {
    return VERSION;
  }

  constructor() {
    this.#status = {
      type: "error",
      message: "Not initialized",
    };
  }

  async init() {
    {
      const ok = await mkdir(this.workdir, { recursive: true }).then(
        () => true,
        () => false,
      );

      if (!ok) {
        this.#status = {
          type: "error",
          message: "Failed to create workdir",
        };

        return;
      }
    }

    {
      const ok = await promisify(exec)("git --version").then(
        (o) => o.stdout.startsWith("git version"),
        () => false,
      );

      if (!ok) {
        this.#status = {
          type: "error",
          message: "Failed to execute command",
        };

        return;
      }
    }

    this.#status = {
      type: "ready",
    };
  }

  async reset() {
    await rm(this.workdir, { force: true, recursive: true });
  }
}

export namespace Environment {
  export type Status =
    | {
        type: "ready";
      }
    | {
        type: "error";
        message: string;
      };
}
