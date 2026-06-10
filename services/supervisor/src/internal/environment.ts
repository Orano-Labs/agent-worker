import { mkdir, rm, stat } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { x } from "tar";

import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

declare const VERSION: string;

export class Environment {
  #logger: Logger;
  #cli: CommandLine;
  #variables: Variables;

  get platform() {
    return platform();
  }

  get arch() {
    return arch();
  }

  get workdir() {
    return this.#variables.get("AW_SUPERVISOR_ROOT_DIR") || join(homedir(), ".aw-supervisor");
  }

  get version() {
    return VERSION;
  }

  get cwd() {
    return this.#cli.cwd;
  }

  get firecracker() {
    return join(this.workdir, `bin/firecracker-${Environment.FIRECRACKER_VERSION}-${this.arch === "x64" ? "x86_64" : "aarch64"}`);
  }

  get jailer() {
    return join(this.workdir, `bin/jailer-${Environment.FIRECRACKER_VERSION}-${this.arch === "x64" ? "x86_64" : "aarch64"}`);
  }

  get kernel() {
    return join(this.workdir, "kernel/vmlinux");
  }

  constructor() {
    this.#logger = Container.inject(Logger).scope("Environment");
    this.#cli = Container.inject(CommandLine);
    this.#variables = Container.inject(Variables);
  }

  async init() {
    const directories = [
      {
        path: this.workdir,
        description: "work",
      },
      {
        path: join(this.workdir, "bin"),
        description: "bin",
      },
      {
        path: join(this.workdir, "kernel"),
        description: "kernel",
      },
      {
        path: join(this.workdir, "images"),
        description: "images",
      },
    ];

    for (const directory of directories) {
      await mkdir(directory.path, { recursive: true });
    }

    const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "";

    if (!arch) {
      throw new Error(`Unsupported architecture: Node.js reports '${process.arch}' but Firecracker requires x64 or arm64.`);
    }

    let exists = true;

    try {
      await stat(this.firecracker);
      await stat(this.jailer);
    } catch {
      exists = false;
    }

    if (exists) {
      return this.#logger.info(`Resources already exists. Skipping download.`);
    }

    const url = Environment.FIRECRACKER_RELEASE_DOWNLOAD_URL.replaceAll("<V>", Environment.FIRECRACKER_VERSION).replaceAll("<ARCH>", arch);

    const body = await fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`Download failed (${basename(url)}): ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error(`Download failed (${basename(url)}): Response body is null`);
      }

      return response.body;
    });

    try {
      await rm(join(this.workdir, "bin"), { force: true, recursive: true });
      await mkdir(join(this.workdir, "bin"), { recursive: true });
      await pipeline(Readable.fromWeb(body), x({ cwd: join(this.workdir, "bin"), strip: 1 }));
    } catch (error) {
      try {
        await rm(join(this.workdir, "bin"), { force: true, recursive: true });
      } catch {}

      throw error;
    }
  }
}

export namespace Environment {
  export const FIRECRACKER_VERSION = "v1.16.0";
  export const FIRECRACKER_RELEASE_DOWNLOAD_URL = `https://github.com/firecracker-microvm/firecracker/releases/download/<V>/firecracker-<V>-<ARCH>.tgz`;
}
