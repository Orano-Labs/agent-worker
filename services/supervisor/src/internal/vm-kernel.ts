import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import type { Shell } from "@/internal/shell";

export class VMKernel extends Container.ServiceConstructable {
  #env: Environment;
  #logger: Logger;
  #shell: Shell;

  get path() {
    return join(this.#env.root, "kernel/vmlinux");
  }

  constructor(...deps: [Environment, Logger, Shell]) {
    super();

    this.#env = deps[0];
    this.#logger = deps[1].namespace("VMKernel");
    this.#shell = deps[2];
  }

  protected override async initialize(signal: AbortSignal) {
    await mkdir(dirname(this.path), { recursive: true });

    const $ = this.#shell.session({ signal, logger: this.#logger });

    let exists = false;

    try {
      await stat(this.path).then(() => {
        exists = true;
      });
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code !== "ENOENT") {
        throw new Error(`Failed to check status for kernel path: ${this.path}`);
      }
    }

    if (exists) {
      return this.#logger.info("Kernel exists. Skipping build.");
    }

    const bundled = join(process.cwd(), "ci/vmlinux");

    try {
      await stat(bundled);
      await copyFile(bundled, this.path);

      return this.#logger.info(`Bundled kernel found at ${bundled}. Copied to ${this.path}.`);
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code !== "ENOENT") {
        throw new Error(`Failed to check bundled kernel: ${bundled}`, {
          cause: e,
        });
      }
    }

    const config = VMKernel.KERNEL_CONFIG_NAMES[process.arch];

    if (!config) {
      throw new Error(`Unsupported architecture: ${process.arch}`);
    }

    this.#logger.info(`Kernel not found at ${this.path}. Building from source...`);

    const workdir = join(tmpdir(), `linux-kernel-${crypto.randomUUID()}`);

    try {
      await $`git clone --depth 1 --branch ${VMKernel.KERNEL_BRANCH} ${VMKernel.KERNEL_REPO} ${workdir}`;

      const $kernel = $({ cwd: workdir });

      this.#logger.info("Downloading Firecracker kernel config...");

      await $kernel`curl -L -o .config ${`${VMKernel.KERNEL_CONFIG_BASE_URL}/${config}`}`;

      const configs: Array<readonly [string, string, string?]> = [
        ["--disable", "SYSTEM_TRUSTED_KEYRING"],
        ["--disable", "SECONDARY_TRUSTED_KEYRING"],
        ["--disable", "SYSTEM_REVOCATION_KEYS"],
        ["--disable", "MODULE_SIG"],
        ["--disable", "INTEGRITY"],
        ["--disable", "IMA"],
        ["--disable", "EVM"],
        ["--set-str", "SYSTEM_TRUSTED_KEYS", ""],
        ["--set-str", "SYSTEM_REVOCATION_KEYS", ""],
        // 启用 virtio-mmio cmdline 设备（Firecracker 注册设备所需）
        ["--enable", "VIRTIO_MMIO_CMDLINE_DEVICES"],
        ["--disable", "BLK_DEV_INTEGRITY"],
        // 启用 NFSv3 客户端支持
        ["--enable", "NFS_V3"],
        ["--enable", "NFS_V3_ACL"],
        ["--enable", "LOCKD_V4"],
      ];

      for (const [action, key, value] of configs) {
        await $kernel`./scripts/config ${action} ${key} ${value ?? ""}`;
      }

      this.#logger.info("Updating kernel config via olddefconfig...");

      await $kernel`make olddefconfig`;

      this.#logger.info("Building kernel...");

      const jobs = availableParallelism();
      const target = process.arch === "arm64" ? "arch/arm64/boot/Image" : "vmlinux";

      // 使用 C11 规避旧内核与 C23 关键字冲突；ARM64 下 Firecracker 需要 Image 格式而非 vmlinux
      await $kernel`make -j${jobs} ${process.arch === "arm64" ? "Image" : "vmlinux"} CC="gcc -std=gnu11"`;
      await $kernel`cp ${join(workdir, target)} ${this.path}`;
    } finally {
      await rm(workdir, { recursive: true }).catch(() => {});
    }

    this.#logger.info(`Kernel built successfully at: ${this.path}`);
  }
}

export namespace VMKernel {
  export const KERNEL_REPO = "https://github.com/amazonlinux/linux.git";
  export const KERNEL_BRANCH = "microvm-kernel-6.1.102-1.182.amzn2023";

  export const KERNEL_CONFIG_BASE_URL =
    "https://raw.githubusercontent.com/firecracker-microvm/firecracker/refs/heads/main/resources/guest_configs";

  export const KERNEL_CONFIG_NAMES: Partial<Record<NodeJS.Architecture, string>> = {
    x64: "microvm-kernel-ci-x86_64-6.1.config",
    arm64: "microvm-kernel-ci-aarch64-6.1.config",
  };
}
