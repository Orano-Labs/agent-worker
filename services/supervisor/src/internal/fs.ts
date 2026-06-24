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
import { Variables } from "@/internal/variables";

export class FS {
  #logger: Logger;
  #variables: Variables;
  #env: Environment;

  constructor() {
    this.#logger = Container.inject(Logger).scope("FS");
    this.#variables = Container.inject(Variables);
    this.#env = Container.inject(Environment);
  }

  get root() {
    return this.#variables.get("AW_SUPERVISOR_FS_ROOT") || join(this.#env.workdir, "fs");
  }

  get #socket() {
    return join(this.#env.workdir, "webdav.socket");
  }

  async create(options: FS.Options) {
    const workspace = join("projects", options.config.projectId);

    const formData = new FormData();

    formData.append("password", options.password);
    formData.append("dir", workspace);

    await mkdir(join(this.root, workspace), { recursive: true });
    await fetch(`http://localhost/expose/${options.id}`, {
      method: "POST",
      body: formData,
      // @ts-expect-error
      dispatcher: new Agent({
        socketPath: this.#socket,
      }),
    });

    return {
      release: async () => {
        await fetch(`http://localhost/expose/${options.id}`, {
          method: "DELETE",
          // @ts-expect-error
          dispatcher: new Agent({
            socketPath: this.#socket,
          }),
        });
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
      stdio: ["inherit", "pipe", "pipe"],
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
  }
}

export namespace FS {
  export type Options = {
    readonly id: string;
    readonly config: Orchestrator.TaskConfig;
    readonly password: string;
  };

  export type Instance = {
    readonly release: () => Promise<void>;
  };
}
