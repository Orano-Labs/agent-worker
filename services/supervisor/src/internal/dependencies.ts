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

  get juicefs() {
    const v = Dependencies.JFS_VERSION;
    const a = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "arm64" : "";

    return join(this.#environment.root, `bin/juicefs-${v}-${a}`);
  }

  get firecrackerVersion() {
    return Dependencies.FIRECRACKER_VERSION;
  }

  get juicefsVersion() {
    return Dependencies.JFS_VERSION;
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

  async #installJuicefs(signal: AbortSignal) {
    const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";

    if (!arch) {
      throw new Error(`Unsupported architecture: Node.js reports '${process.arch}' but JuiceFS requires x64 or arm64.`);
    }

    let exists = true;

    try {
      await stat(this.juicefs);
    } catch {
      exists = false;
    }

    if (exists) {
      return this.#logger.info("JuiceFS binaries already exist. Skipping download.");
    }

    const url = Dependencies.JFS_RELEASE_DOWNLOAD_URL.replaceAll("<ARCH>", arch);
    const dst = join(tmpdir(), `juicefs-download-${crypto.randomUUID()}`);

    this.#logger.info(`Downloading JuiceFS ${Dependencies.JFS_VERSION} from ${url}...`);

    const body = await this.#download(url, signal);

    try {
      this.#logger.info(`Extracting JuiceFS assets to temporary directory: ${dst}`);

      await mkdir(dst, { recursive: true });
      await pipeline(Readable.fromWeb(body), x({ cwd: dst }));

      this.#logger.info(`Copying JuiceFS binaries to production bin directory...`);

      await cp(join(dst, "juicefs"), join(this.#environment.root, "bin", basename(this.juicefs)));

      this.#logger.info(`JuiceFS binary installed successfully.`);
    } finally {
      await rm(dst, { recursive: true }).catch(() => {});
    }
  }

  protected async initialize(signal: AbortSignal) {
    this.#logger.info(`Working directory base path: ${this.#environment.root}`);

    await mkdir(join(this.#environment.root, "bin"), { recursive: true });

    this.#logger.info(`Verifying and installing core component dependencies...`);

    await Promise.all([this.#installFirecracker(signal), this.#installJuicefs(signal)]);

    this.#logger.info(`Dependencies initialization completed successfully.`);
  }
}

export namespace Dependencies {
  export const FIRECRACKER_REPO = "https://github.com/firecracker-microvm/firecracker";
  export const FIRECRACKER_VERSION = "v1.16.0";
  export const FIRECRACKER_RELEASE_DOWNLOAD_URL = `${FIRECRACKER_REPO}/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-<ARCH>.tgz`;

  export const JFS_REPO = "https://d.juicefs.com/juicefs";
  export const JFS_VERSION = "v1.4.1";
  export const JFS_RELEASE_DOWNLOAD_URL = `${JFS_REPO}/releases/download/${JFS_VERSION}/juicefs-${JFS_VERSION.slice(1)}-linux-<ARCH>.tar.gz`;
}
