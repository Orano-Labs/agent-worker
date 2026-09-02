import { cp, mkdir, rm, stat } from "node:fs/promises";
import { arch, homedir, platform, tmpdir } from "node:os";
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
    const v = Environment.FIRECRACKER_VERSION;
    const a = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "";

    return join(this.workdir, `bin/firecracker-${v}-${a}`);
  }

  get jailer() {
    const v = Environment.FIRECRACKER_VERSION;
    const a = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "";

    return join(this.workdir, `bin/jailer-${v}-${a}`);
  }

  get juicefs() {
    const v = Environment.FIRECRACKER_VERSION;
    const a = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "";

    return join(this.workdir, `bin/juicefs-${v}-${a}`);
  }

  get kernel() {
    return join(this.workdir, "kernel/vmlinux");
  }

  constructor() {
    this.#logger = Container.inject(Logger).scope("Environment");
    this.#cli = Container.inject(CommandLine);
    this.#variables = Container.inject(Variables);
  }

  async #installFirecracker() {
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
      return this.#logger.info("Firecracker binaries already exist. Skipping download.");
    }

    const url = Environment.FIRECRACKER_RELEASE_DOWNLOAD_URL.replaceAll("<ARCH>", arch);
    const dst = join(tmpdir(), `fc-download-${crypto.randomUUID()}`);

    this.#logger.info(`Downloading Firecracker ${Environment.FIRECRACKER_VERSION} from ${url}...`);

    const body = await fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`Download failed (${url}): ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error(`Download failed (${url}): Response body is null`);
      }

      return response.body;
    });

    try {
      this.#logger.info(`Extracting Firecracker assets to temporary directory: ${dst}`);

      await mkdir(dst, { recursive: true });
      await pipeline(Readable.fromWeb(body), x({ cwd: dst, strip: 1 }));

      this.#logger.info(`Copying binaries to production bin directory...`);

      await cp(join(dst, basename(this.firecracker)), join(this.workdir, "bin", basename(this.firecracker)));
      await cp(join(dst, basename(this.jailer)), join(this.workdir, "bin", basename(this.jailer)));

      this.#logger.info(`Firecracker and Jailer binaries installed successfully.`);
    } finally {
      await rm(dst).catch(() => {});
    }
  }

  async init() {
    this.#logger.info(`Working directory base path: ${this.workdir}`);

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
      {
        path: join(this.workdir, "fs"),
        description: "juice-fs mount point",
      },
    ];

    for (const directory of directories) {
      await mkdir(directory.path, { recursive: true });
    }

    this.#logger.info(`Verifying and installing core component dependencies...`);

    await this.#installFirecracker();

    this.#logger.info(`Environment initialization completed successfully.`);
  }
}

export namespace Environment {
  export const FIRECRACKER_REPO = "https://github.com/firecracker-microvm/firecracker";
  export const FIRECRACKER_VERSION = "v1.16.0";
  export const FIRECRACKER_RELEASE_DOWNLOAD_URL = `${FIRECRACKER_REPO}/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-<ARCH>.tgz`;
}
