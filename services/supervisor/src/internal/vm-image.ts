import { mkdir, stat } from "node:fs/promises";
import { arch } from "node:os";
import { dirname, join } from "node:path";
import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { binaryLinuxARM64, binaryLinuxX64 } from "@aw/ptyd";
import type { Dependencies } from "@/internal/dependencies";
import type { Shell } from "@/internal/shell";

const RUNTIME_IMAGE_CONTAINER_NAME = "aw-runtime-image";

export class VMImage extends Container.ServiceConstructable {
  #environment: Environment;
  #logger: Logger;
  #shell: Shell;

  get runtime() {
    return join(this.#environment.root, "images", "runtime.squashfs");
  }

  constructor(...deps: [Environment, Logger, Shell]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("VMImage");
    this.#shell = deps[2];
  }

  protected override async initialize(signal: AbortSignal) {
    await mkdir(dirname(this.runtime), { recursive: true });

    const $ = this.#shell.session({ signal, logger: this.#logger });

    // let exists = true;

    // try {
    //   await stat(this.runtime);
    // } catch (e) {
    //   exists = false;

    //   if (e instanceof Error && "code" in e && e.code !== "ENOENT") {
    //     throw new Error(`Failed to check status for runtime image path: ${this.runtime}`);
    //   }
    // }

    // if (!exists) {
    //   this.#logger.debug(`Runtime image snapshot not found at ${this.runtime}. Proceeding with creation.`);
    // } else {
    //   this.#logger.info("Base image snapshot exists. Skipping initialization.");
    // }

    let containerExists = true;
    let containerTemp = "";

    try {
      try {
        await $`buildah inspect ${RUNTIME_IMAGE_CONTAINER_NAME}`;
      } catch {
        containerExists = false;
      }

      if (!containerExists) {
        this.#logger.info("No existing container found, starting fresh build...");
        this.#logger.info("Pulling alpine base image via buildah...");

        await $`buildah from alpine:latest`.then(({ stdout }) => {
          containerTemp = stdout.trim();
        });

        this.#logger.info("Injecting DNS configurations into container...");

        await $`buildah copy ${containerTemp} /etc/resolv.conf /etc/resolv.conf`;

        this.#logger.info("Installing internal packages...");

        const MIRROR_MAIN = "https://mirrors.nju.edu.cn/alpine/latest-stable/main/";
        const DEPS = ["tini", "nodejs", "npm", "curl", "fuse", "bubblewrap"];

        // Pi needed
        DEPS.push("fd", "ripgrep");

        await $`buildah run --net=host ${containerTemp} -- apk update --repository=${MIRROR_MAIN}`;
        await $`buildah run --net=host ${containerTemp} -- apk add ca-certificates --repository=${MIRROR_MAIN}`;
        await $`buildah run --net=host ${containerTemp} -- apk add ${DEPS} --repository=${MIRROR_MAIN}`;
        await $`buildah run --net=host ${containerTemp} -- npm install -g --ignore-scripts @earendil-works/pi-coding-agent`;

        this.#logger.info(`Renaming container to ${RUNTIME_IMAGE_CONTAINER_NAME} for future caching...`);

        await $`buildah rename ${containerTemp} ${RUNTIME_IMAGE_CONTAINER_NAME}`;

        containerTemp = "";
      }

      this.#logger.info("Injecting DNS configurations and init scripts into container...");

      const ptyd = arch() === "arm64" ? binaryLinuxARM64 : binaryLinuxX64;

      console.log(process.cwd());

      await $`buildah copy ${RUNTIME_IMAGE_CONTAINER_NAME} ${join(process.cwd(), "resources/init.sh")} /init`;
      await $`buildah copy ${RUNTIME_IMAGE_CONTAINER_NAME} ${join(process.cwd(), "resources/entrypoint.sh")} /entrypoint`;
      await $`buildah copy ${RUNTIME_IMAGE_CONTAINER_NAME} ${ptyd} /usr/local/bin/ptyd`;

      await $`buildah run --net=host ${RUNTIME_IMAGE_CONTAINER_NAME} -- chmod +x /init`;
      await $`buildah run --net=host ${RUNTIME_IMAGE_CONTAINER_NAME} -- chmod +x /entrypoint`;
      await $`buildah run --net=host ${RUNTIME_IMAGE_CONTAINER_NAME} -- chmod +x /usr/local/bin/ptyd`;
      await $`buildah run --net=host ${RUNTIME_IMAGE_CONTAINER_NAME} -- mkdir -p /workspace`;

      this.#logger.info(`Mounting container rootfs to build Squashfs...`);

      await $`buildah mount ${RUNTIME_IMAGE_CONTAINER_NAME}`.then(({ stdout }) => {
        return $`mksquashfs ${stdout.trim()} ${this.runtime} -comp xz -noappend`;
      });
    } finally {
      if (containerTemp) {
        this.#logger.debug(`Destroying buildah container [${containerTemp}]...`);

        await $`buildah unmount ${containerTemp}`.catch((err) => {
          this.#logger.warn(`Failed to unmount container [${containerTemp}]`, { err });
        });
        await $`buildah rm ${containerTemp}`.catch((err) => {
          this.#logger.warn(`Failed to remove container [${containerTemp}]`, { err });
        });
      }
    }

    this.#logger.info(`Base image snapshot archived successfully at: ${this.runtime}`);
  }

  async createScratchFS(dest: string, size = 512) {
    const $ = this.#shell.session({ signal: new AbortController().signal, logger: this.#logger });

    this.#logger.info(`Creating a writable scratch FS of ${size} MiB at: ${dest}`);

    await $`truncate -s ${`${size}M`} ${dest}`;
    await $`mkfs.ext4 -F -b 4096 ${dest}`;

    this.#logger.info(`ScratchFS created successfully.`);
  }
}
