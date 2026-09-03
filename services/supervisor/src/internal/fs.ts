import { spawn } from "node:child_process";
import { access, constants, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface as createReadLineInterface } from "node:readline";
import { bin } from "@aw/webdav";
import { asError } from "catch-unknown";
import { Agent } from "undici";
import { Container } from "@/helpers/container";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";
import type { Orchestrator } from "@/internal/orchestrator";
import { Terminator } from "./terminator";

export class FS {
  #logger: Logger;
  #env: Environment;
  #terminator: Terminator;

  constructor() {
    this.#logger = Container.inject(Logger).prefix("FS");
    this.#env = Container.inject(Environment);
    this.#terminator = Container.inject(Terminator);
  }

  get root() {
    return process.env.AW_SUPERVISOR_FS_ROOT || join(this.#env.workdir, "fs");
  }

  get #socket() {
    return join(this.#env.workdir, "webdav.socket");
  }

  async #fetch(path: string, init: RequestInit) {
    return fetch(new URL(path, "http://localhost"), {
      ...init,
      // @ts-expect-error
      dispatcher: new Agent({
        socketPath: this.#socket,
      }),
    });
  }

  async create(options: FS.Options) {
    const workspace = join("projects", options.projectId);

    const formData = new FormData();

    formData.append("password", options.password);
    formData.append("dir", workspace);

    await mkdir(join(this.root, workspace), { recursive: true });
    await this.#fetch(`/expose/${options.id}`, { method: "POST", body: formData });

    return {
      release: async () => {
        await this.#fetch(`/expose/${options.id}`, { method: "DELETE" });
      },
    };
  }

  async init() {
    const root = this.root;

    try {
      await mkdir(root, { recursive: true });
      await access(root, constants.R_OK | constants.W_OK);

      this.#logger.info(`File system root directory is ready. Path: ${root}`);
    } catch (error) {
      throw new Error(`Failed to initialize file system root directory [${root}]. Underlying error: ${asError(error).message}`);
    }

    const socket = join(this.#env.workdir, "webdav.socket");
    const ps = spawn(bin, ["-p", "26088", "-s", socket, "-r", root], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise<void>((resolve, reject) => {
      ps.on("spawn", resolve);
      ps.on("error", reject);
    });

    this.#logger.info(`WebDAV server creation completed (socket: ${socket})`);

    createReadLineInterface(ps.stderr).on("line", (line) => {
      this.#logger.info(line);
    });

    createReadLineInterface(ps.stdout).on("line", (line) => {
      this.#logger.info(line);
    });

    this.#terminator.register(async () => {
      if (ps.killed) {
        return;
      }

      ps.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        ps.once("close", resolve);
        ps.once("error", resolve);
      });
    });
  }
}

export namespace FS {
  export type Options = {
    readonly id: string;
    readonly projectId: string;
    readonly password: string;
  };

  export type Instance = {
    readonly release: () => Promise<void>;
  };
}
