import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { Shell } from "@/internal/shell";

const RUNTIME_IMAGE_FILE = "runtime.squashfs";

export class VMImage extends Container.ServiceConstructable {
  #environment: Environment;
  #logger: Logger;
  #shell: Shell;

  get runtime() {
    // The runtime image is a read-only build artifact. In production it lives
    // outside the runtime volume (set via AW_SUPERVISOR_RUNTIME_IMAGE); for
    // local development it defaults to <root>/images/runtime.squashfs.
    return this.#environment.get("RUNTIME_IMAGE") ?? join(this.#environment.root, "images", RUNTIME_IMAGE_FILE);
  }

  constructor(...deps: [Environment, Logger, Shell]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("VMImage");
    this.#shell = deps[2];
  }

  protected override async initialize(signal: AbortSignal) {
    signal.throwIfAborted();

    await mkdir(dirname(this.runtime), { recursive: true });

    // The runtime image is no longer built here at startup. It is produced by
    // scripts/build-runtime-image.sh during the image build phase (see
    // docker/Dockerfile.supervisor) and shipped as a prebuilt artifact. The
    // Supervisor only validates that it is present before booting VMs.
    let exists = true;

    try {
      const result = await stat(this.runtime);

      if (!result.isFile() || result.size === 0) {
        exists = false;
      }
    } catch (e) {
      exists = false;

      if (e instanceof Error && "code" in e && e.code !== "ENOENT") {
        throw new Error(`Failed to check status for runtime image path: ${this.runtime}`, { cause: e });
      }
    }

    if (!exists) {
      throw new Error(
        `Runtime image not found at ${this.runtime}. Build it with scripts/build-runtime-image.sh (or ship it as a prebuilt artifact) before starting the Supervisor.`,
      );
    }

    this.#logger.info("Runtime image snapshot verified", { path: this.runtime });
  }

  async createScratchFS(dest: string, size = 512) {
    const $ = this.#shell.session({ signal: new AbortController().signal, logger: this.#logger });

    await $`truncate -s ${`${size}M`} ${dest}`;
    await $`mkfs.ext4 -F -b 4096 ${dest}`;
  }
}
