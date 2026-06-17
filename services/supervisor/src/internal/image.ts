import { exec } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Container } from "@/helpers/container";
import { ErrorHelpers } from "@/helpers/error-helpers";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";

const RUNTIME_IMAGE_CONTAINER_NAME = "aw-runtime-image";

export class Image {
  #env: Environment;
  #logger: Logger;

  get runtime() {
    return join(this.#env.workdir, "images", "runtime.squashfs");
  }

  constructor() {
    this.#env = Container.inject(Environment);
    this.#logger = Container.inject(Logger).scope("Image");
  }

  async #exec(command: string) {
    return promisify(exec)(command);
  }

  async init() {
    const exists = false;

    try {
      await stat(this.runtime);
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code !== "ENOENT") {
        throw new Error(`Failed to check status for runtime image path: ${this.runtime}`);
      }
    }

    if (exists) {
      // return this.#logger.info("Base image snapshot exists. Skipping initialization.");
    }

    this.#logger.debug(`Runtime image snapshot not found at ${this.runtime}. Proceeding with creation.`);

    let containerExists = true;
    let containerTemp = "";

    try {
      this.#logger.info("Installing required packages (buildah, qemu-utils, e2fsprogs)...");

      await this.#exec("sudo apt install -y buildah qemu-utils e2fsprogs");

      try {
        await this.#exec(`buildah inspect ${RUNTIME_IMAGE_CONTAINER_NAME}`);
      } catch {
        containerExists = false;
      }

      if (!containerExists) {
        this.#logger.info("No existing container found, starting fresh build...");
        this.#logger.info("Pulling alpine base image via buildah...");

        await this.#exec("buildah from alpine:latest").then(({ stdout }) => {
          containerTemp = stdout.trim();
        });

        this.#logger.info("Injecting DNS configurations into container...");

        await this.#exec(`buildah copy ${containerTemp} /etc/resolv.conf /etc/resolv.conf`);

        this.#logger.info("Installing internal packages...");

        const MIRROR_MAIN = "https://mirrors.nju.edu.cn/alpine/latest-stable/main/";

        await this.#exec(`buildah run --net=host ${containerTemp} -- apk update --repository=${MIRROR_MAIN}`);
        await this.#exec(`buildah run --net=host ${containerTemp} -- apk add ca-certificates --repository=${MIRROR_MAIN}`);
        await this.#exec(`buildah run --net=host ${containerTemp} -- apk add tini nodejs curl fuse davfs2 --repository=${MIRROR_MAIN}`);

        this.#logger.info(`Renaming container to ${RUNTIME_IMAGE_CONTAINER_NAME} for future caching...`);

        await this.#exec(`buildah rename ${containerTemp} ${RUNTIME_IMAGE_CONTAINER_NAME}`);

        containerTemp = "";
      }

      this.#logger.info("Injecting DNS configurations and init scripts into container...");

      await this.#exec(`buildah copy ${RUNTIME_IMAGE_CONTAINER_NAME} ${join(process.cwd(), "resources/init.sh")} /init`);
      await this.#exec(`buildah copy ${RUNTIME_IMAGE_CONTAINER_NAME} ${join(process.cwd(), "resources/entrypoint.sh")} /entrypoint`);
      await this.#exec(`buildah copy ${RUNTIME_IMAGE_CONTAINER_NAME} ${join(process.cwd(), "resources/app")} /app`);

      await this.#exec(`buildah run --net=host ${RUNTIME_IMAGE_CONTAINER_NAME} -- chmod +x /init`);
      await this.#exec(`buildah run --net=host ${RUNTIME_IMAGE_CONTAINER_NAME} -- chmod +x /entrypoint`);
      await this.#exec(`buildah run --net=host ${RUNTIME_IMAGE_CONTAINER_NAME} -- mkdir -p /workspace`);

      this.#logger.info(`Mounting container rootfs to build Squashfs...`);

      await this.#exec(
        `buildah unshare sh -c 'set -e && m=$(buildah mount ${RUNTIME_IMAGE_CONTAINER_NAME}) && mksquashfs "$m" "${this.runtime}" -comp xz -noappend'`,
      );
    } finally {
      if (containerTemp) {
        this.#logger.debug(`Destroying buildah container [${containerTemp}]...`);

        await this.#exec(`buildah unmount ${containerTemp}`).catch((err) => {
          this.#logger.warn(`Failed to unmount container [${containerTemp}]: ${ErrorHelpers.as(err).message}`);
        });
        await this.#exec(`buildah rm ${containerTemp}`).catch((err) => {
          this.#logger.warn(`Failed to remove container [${containerTemp}]: ${ErrorHelpers.as(err).message}`);
        });
      }
    }

    this.#logger.info(`Base image snapshot archived successfully at: ${this.runtime}`);
  }

  async createScratchFS(dest: string, size = 512) {
    this.#logger.info(`Creating a writable scratch FS of ${size} MiB at: ${dest}`);

    await this.#exec(`truncate -s ${size}M ${dest}`);
    await this.#exec(`mkfs.ext4 -F -b 4096 ${dest}`);

    this.#logger.info(`ScratchFS created successfully.`);
  }
}
