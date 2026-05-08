import { exec } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { Writable } from "node:stream";

export class VMEnvironment {
  #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  get root() {
    return this.#root;
  }

  get firecracker() {
    return this.#resolvePathFromRoot("bin/firecracker");
  }

  get jailer() {
    return this.#resolvePathFromRoot("bin/jailer");
  }

  get chroot() {
    return this.#resolvePathFromRoot("/vms");
  }

  get vmlinux() {
    return this.#resolvePathFromRoot("kernels/vmlinux");
  }

  get ubuntu() {
    return this.#resolvePathFromRoot("images/ubuntu.squashfs");
  }

  #ensureDirSync(path: string) {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }

  #resolvePathFromRoot(path: string) {
    return join(this.#root, path);
  }

  async #downloadFirecrackerComponents() {
    const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "";

    if (!arch) {
      throw new Error(`Unsupported architecture: ${process.arch}`);
    }

    this.#ensureDirSync(this.#resolvePathFromRoot(".download"));

    await Promise.all(
      VMEnvironment.FIRECRACKER_RESOURCES.map(async (item) => {
        if (existsSync(this.#resolvePathFromRoot(item.install))) {
          return;
        }

        const url = `${VMEnvironment.FIRECRACKER_AWS_BUCKET_URL}/${item.key.replace("<ARCH>", arch)}`;
        const dst = this.#resolvePathFromRoot(`.download/${item.name}`);

        await this.#downloadFile(url, dst);

        cpSync(this.#resolvePathFromRoot(`.download/${item.name}`), this.#resolvePathFromRoot(item.install));

        if (item.install.startsWith("/bin")) {
          await this.#exec(`sudo chmod +x ${this.#resolvePathFromRoot(item.install)}`);
        }
      }),
    );

    rmSync(this.#resolvePathFromRoot(".download"), { recursive: true, force: true });
  }

  async #downloadFile(url: string, target: string) {
    return fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Download failed (${basename(url)}): ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error(`Download failed (${basename(url)}): Response body is null`);
        }

        return response.body;
      })
      .then(async (body) => {
        await body.pipeTo(Writable.toWeb(createWriteStream(target)));
      });
  }

  async #exec(command: string) {
    return new Promise<string>((resolve, reject) => {
      exec(command, (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async init() {
    this.#ensureDirSync(this.#resolvePathFromRoot("/"));
    this.#ensureDirSync(this.#resolvePathFromRoot("/bin"));
    this.#ensureDirSync(this.#resolvePathFromRoot("/kernels"));
    this.#ensureDirSync(this.#resolvePathFromRoot("/images"));
    this.#ensureDirSync(this.#resolvePathFromRoot("/snapshots"));
    this.#ensureDirSync(this.#resolvePathFromRoot("/vms/firecracker"));

    await this.#downloadFirecrackerComponents();
  }
}

export namespace VMEnvironment {
  export const FIRECRACKER_GIT_REPO_URL = "https://github.com/firecracker-microvm/firecracker";

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
      install: "/kernels/vmlinux",
    },
    {
      key: "firecracker-ci/v1.15/<ARCH>/ubuntu-24.04.squashfs",
      name: "ubuntu.squashfs",
      install: "/images/ubuntu.squashfs",
    },
  ] as const;
}
