import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { createInterface as createReadLineInterface } from "node:readline";
import { bin } from "@aw/webdav";
import { asError } from "catch-unknown";
import { Agent } from "undici";
import { Container } from "@/helpers/container";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";
import { Terminator } from "./terminator";

export class VMWorkspace {
  #logger: Logger;
  #env: Environment;
  #terminator: Terminator;

  constructor() {
    this.#logger = Container.inject(Logger).prefix("VMWorkspace");
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

  async expose(options: VMWorkspace.Options) {
    const workspace = join("projects", options.projectId);
    const password = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");

    const formData = new FormData();

    formData.append("password", password);
    formData.append("client_ip", options.ip);
    formData.append("dir", workspace);

    const workspacePath = join(this.root, workspace);

    try {
      await access(workspacePath, constants.R_OK | constants.W_OK);
    } catch (error) {
      throw new Error(`Project directory does not exist or is not accessible: ${workspacePath}`);
    }

    await this.#fetch(`/expose/${options.id}`, { method: "POST", body: formData });

    return password;
  }

  async unexpose(id: string) {
    await this.#fetch(`/expose/${id}`, { method: "DELETE" });
  }

  async init() {
    const root = this.root;

    try {
      await access(root, constants.R_OK | constants.W_OK);
    } catch (error) {
      throw new Error(
        `File system root directory does not exist or is not accessible [${root}]. Underlying error: ${asError(error).message}`,
      );
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

export namespace VMWorkspace {
  export type Options = {
    readonly id: string;
    readonly projectId: string;
    readonly ip: string;
  };
}
