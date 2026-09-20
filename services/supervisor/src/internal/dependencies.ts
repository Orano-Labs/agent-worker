import { cp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { x } from "tar";

export class Dependencies extends Container.ServiceConstructable {
  #logger: Logger;
  #environment: Environment;

  get firecracker() {
    const v = Dependencies.FIRECRACKER_VERSION;
    const a = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "";

    return join(this.#environment.root, `bin/firecracker-${v}-${a}`);
  }

  get firecrackerVersion() {
    return Dependencies.FIRECRACKER_VERSION;
  }

  get jailer() {
    const v = Dependencies.FIRECRACKER_VERSION;
    const a = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "";

    return join(this.#environment.root, `bin/jailer-${v}-${a}`);
  }

  constructor(...deps: [Environment, Logger]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("Dependencies");
  }

  async #download(url: string, signal: AbortSignal) {
    return fetch(url, { signal }).then((response) => {
      if (!response.ok) {
        throw new Error(`Download failed (${url}): ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error(`Download failed (${url}): Response body is null`);
      }

      return response.body;
    });
  }

  async #installFirecracker(signal: AbortSignal) {
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

    const url = Dependencies.FIRECRACKER_RELEASE_DOWNLOAD_URL.replaceAll("<ARCH>", arch);
    const dst = join(tmpdir(), `fc-download-${crypto.randomUUID()}`);

    this.#logger.info(`Downloading Firecracker ${Dependencies.FIRECRACKER_VERSION} from ${url}...`);

    const body = await this.#download(url, signal);

    try {
      this.#logger.info(`Extracting Firecracker assets to temporary directory: ${dst}`);

      await mkdir(dst, { recursive: true });
      await pipeline(Readable.fromWeb(body), x({ cwd: dst, strip: 1 }));

      this.#logger.info(`Copying binaries to production bin directory...`);

      await cp(join(dst, basename(this.firecracker)), join(this.#environment.root, "bin", basename(this.firecracker)));
      await cp(join(dst, basename(this.jailer)), join(this.#environment.root, "bin", basename(this.jailer)));

      this.#logger.info(`Firecracker and Jailer binaries installed successfully.`);
    } finally {
      await rm(dst, { recursive: true }).catch(() => {});
    }
  }

  protected async initialize(signal: AbortSignal) {
    this.#logger.info(`Working directory base path: ${this.#environment.root}`);

    await mkdir(join(this.#environment.root, "bin"), { recursive: true });

    this.#logger.info(`Verifying and installing core component dependencies...`);

    await Promise.all([this.#installFirecracker(signal)]);

    this.#logger.info(`Dependencies initialization completed successfully.`);
  }
}

export namespace Dependencies {
  export const FIRECRACKER_REPO = "https://github.com/firecracker-microvm/firecracker";
  export const FIRECRACKER_VERSION = "v1.16.0";
  export const FIRECRACKER_RELEASE_DOWNLOAD_URL = `${FIRECRACKER_REPO}/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-<ARCH>.tgz`;
}
