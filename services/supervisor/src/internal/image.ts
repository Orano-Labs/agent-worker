import { exec } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { Container } from "@/helpers/container";
import { ErrorHelpers } from "@/helpers/error-helpers";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";

const BASE_IMAGE_SNAPSHOT_NAME = "fc-alpine-base.fs";

export class Image {
  #env: Environment;
  #logger: Logger;

  get base() {
    return join(this.#env.workdir, BASE_IMAGE_SNAPSHOT_NAME);
  }

  constructor() {
    this.#env = Container.inject(Environment);
    this.#logger = Container.inject(Logger).scope("Image");
  }

  async #exec(command: string) {
    return promisify(exec)(command);
  }

  async init() {
    let exists = false;

    try {
      await stat(this.base).then((stats) => {
        exists = stats.isFile();
      });
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code !== "ENOENT") {
        this.#logger.errorFrom(e, `Failed to check status for base path: ${this.base}`);
        process.exit(1);
      }
    }

    if (exists) {
      // return this.#logger.info("Base image snapshot exists. Skipping initialization.");
    }

    this.#logger.debug(`Base image snapshot not found at ${this.base}. Proceeding with creation.`);

    let container = "";
    let ok = false;

    try {
      this.#logger.info("Installing required packages (buildah, qemu-utils, e2fsprogs)...");

      await this.#exec("sudo apt install -y buildah qemu-utils e2fsprogs");

      this.#logger.info("Pulling Alpine base image via buildah...");

      await this.#exec("buildah from alpine:latest").then(({ stdout }) => {
        container = stdout.trim();
      });

      this.#logger.info("Injecting DNS configurations and init scripts into container...");

      await this.#exec(`buildah copy ${container} /etc/resolv.conf /etc/resolv.conf`);
      await this.#exec(`buildah copy ${container} ${join(process.cwd(), "resources/init.sh")} /init`);
      await this.#exec(`buildah copy ${container} ${join(process.cwd(), "resources/app")} /app`);

      this.#logger.info("Setting executable permissions and installing internal packages...");

      await this.#exec(`buildah run --net=host ${container} chmod +x /init`);
      await this.#exec(`buildah run --net=host ${container} mkdir /workspace`);
      await this.#exec(
        `buildah run --net=host ${container} -- sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories`,
      );

      await this.#exec(`buildah run --net=host ${container} -- apk update`);
      await this.#exec(`buildah run --net=host ${container} -- apk add --no-cache tini nodejs`);

      this.#logger.info(`Mounting container rootfs to build Squashfs...`);

      await this.#exec(
        `buildah unshare sh -c 'set -e && m=$(buildah mount ${container}) && mksquashfs "$m" "${this.base}" -comp xz -noappend'`,
      );

      ok = true;
    } catch (error) {
      this.#logger.errorFrom(error, "An error occurred during rootfs initialization.");
    } finally {
      if (container) {
        this.#logger.debug(`Destroying buildah container [${container}]...`);

        await this.#exec(`buildah unmount ${container}`).catch((err) => {
          this.#logger.warn(`Failed to unmount container [${container}]: ${ErrorHelpers.as(err).message}`);
        });
        await this.#exec(`buildah rm ${container}`).catch((err) => {
          this.#logger.warn(`Failed to remove container [${container}]: ${ErrorHelpers.as(err).message}`);
        });
      }
    }

    if (!ok) {
      process.exit(1);
    } else {
      this.#logger.info(`Base image snapshot archived successfully at: ${this.base}`);
    }
  }
}
