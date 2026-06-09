import { createWriteStream } from "node:fs";
import { chmod, cp, mkdir, rm, stat } from "node:fs/promises";
import { arch, homedir, platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Writable } from "node:stream";

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
    return join(this.workdir, "bin/firecracker");
  }

  get jailer() {
    return join(this.workdir, "bin/jailer");
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
        path: join(this.workdir, "sessions"),
        description: "sessions",
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
        path: join(this.workdir, "layer"),
        description: "layer",
      },
    ];

    for (const directory of directories) {
      try {
        await mkdir(directory.path, { recursive: true });
      } catch (error) {
        this.#logger.errorFrom(error, `Failed to create ${directory.description} directory`);

        return process.exit(1);
      }
    }

    const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "";

    if (!arch) {
      this.#logger.error(`Unsupported architecture: Node.js reports '${process.arch}' but Firecracker requires x64 or arm64.`);
      return process.exit(1);
    }

    for (const item of Environment.FIRECRACKER_RESOURCES) {
      let exists = false;

      try {
        exists = Boolean(await stat(join(this.workdir, item.install)));
      } catch {}

      if (exists) {
        this.#logger.info(`Resource [${item.name}] already exists. Skipping download.`);
        continue;
      }

      const url = `${Environment.FIRECRACKER_AWS_BUCKET_URL}/${item.key.replace("<ARCH>", arch)}`;
      const dst = join(tmpdir(), `firecracker-download-${crypto.randomUUID()}`);

      this.#logger.info(`Downloading resource [${item.name}]...`, { url });

      try {
        const body = await fetch(url).then((response) => {
          if (!response.ok) {
            throw new Error(`Download failed (${basename(url)}): ${response.statusText}`);
          }

          if (!response.body) {
            throw new Error(`Download failed (${basename(url)}): Response body is null`);
          }

          return response.body;
        });

        const path = join(this.workdir, item.install);

        await body.pipeTo(Writable.toWeb(createWriteStream(dst)));
        await cp(dst, path);

        this.#logger.info(`Successfully installed [${item.name}] to ${path}`);

        if (item.install.startsWith("/bin")) {
          await chmod(path, 0o755);
        }
      } catch (error) {
        this.#logger.errorFrom(error, `Failed to fetch or install resource [${item.name}] from ${url}`);
        return process.exit(1);
      } finally {
        try {
          await rm(dst, { force: true });
        } catch {}
      }
    }
  }
}

export namespace Environment {
  export const FIRECRACKER_AWS_BUCKET_URL = "https://s3.amazonaws.com/spec.ccfc.min";
  export const FIRECRACKER_RESOURCES = [
    {
      key: "firecracker-ci/v1.15/<ARCH>/firecracker/firecracker-v1.14.0",
      name: "firecracker",
      install: "/bin/firecracker",
    },
    {
      key: "firecracker-ci/v1.15/<ARCH>/firecracker/jailer-v1.14.0",
      name: "jailer",
      install: "/bin/jailer",
    },
    {
      key: "firecracker-ci/v1.15/<ARCH>/vmlinux-6.1.155",
      name: "vmlinux",
      install: "/kernel/vmlinux",
    },
  ] as const;
}
