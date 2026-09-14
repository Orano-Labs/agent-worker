import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chown, cp, mkdir, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { createInterface as createReadLineInterface } from "node:readline";
import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { $, type ProcessPromise } from "zx";
import { Firecracker } from "@/helpers/firecracker";
import type { Dependencies } from "@/internal/dependencies";
import type { VMImage } from "@/internal/vm-image";
import type { VMKernel } from "@/internal/vm-kernel";
import { VMNet } from "@/internal/vm-net";

export class VMManager extends Container.ServiceConstructable {
  #environment: Environment;
  #logger: Logger;
  #image: VMImage;
  #kernel: VMKernel;
  #net: VMNet;
  #dependencies: Dependencies;

  constructor(...deps: [Environment, Logger, VMImage, VMKernel, VMNet, Dependencies]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("VM");
    this.#image = deps[2];
    this.#kernel = deps[3];
    this.#net = deps[4];
    this.#dependencies = deps[5];
  }

  create(options: Pick<VMManager.VM.Options, "id" | "machineTier" | "metadata">) {
    return new VMManager.VM({
      ...options,

      dependencies: this.#dependencies,
      environment: this.#environment,
      image: this.#image,
      kernel: this.#kernel,
      net: this.#net,
      logger: this.#logger.namespace(options.id),
    });
  }
}

export namespace VMManager {
  export class VM {
    #mac: string;
    #environment: Environment;
    #logger: Logger;
    #image: VMImage;
    #kernel: VMKernel;
    #net: VMNet;
    #dependencies: Dependencies;
    #machineTier: "minimal" | "standard" | "performance";
    #id: string;
    #metadata: Record<string, unknown>;

    constructor(options: VM.Options) {
      this.#mac = (() => {
        const hash = createHash("sha256").update(options.id).digest();
        const bytes: string[] = [];

        for (let i = 0; i < 5; i++) {
          bytes.push(hash[i].toString(16).padStart(2, "0"));
        }

        return `02:${bytes.join(":")}`;
      })();

      this.#logger = options.logger;
      this.#machineTier = options.machineTier;
      this.#logger = options.logger;
      this.#image = options.image;
      this.#kernel = options.kernel;
      this.#net = options.net;
      this.#environment = options.environment;
      this.#dependencies = options.dependencies;
      this.#id = options.id;
      this.#metadata = options.metadata;
    }

    get #machineTierMapMemoryLimit() {
      return {
        minimal: 1024,
        standard: 2048,
        performance: 4096,
      }[this.#machineTier];
    }

    get #machineTierMapCpuCapacity() {
      return {
        minimal: 1,
        standard: 2,
        performance: 4,
      }[this.#machineTier];
    }

    get id() {
      return this.#id;
    }

    get mac() {
      return this.#mac;
    }

    get machineTier() {
      return this.#machineTier;
    }

    get memory() {
      return this.#machineTierMapMemoryLimit;
    }

    get cpus() {
      return this.#machineTierMapCpuCapacity;
    }

    get metadata() {
      return this.#metadata;
    }

    async #buildArgs(ns: VMNet.Namespace) {
      const cpuPeriodUs = CPU_CFS_PERIOD_US;
      const cpuQuotaUs = this.#machineTierMapCpuCapacity * CPU_CFS_PERIOD_US;

      const totalMemoryBytes = (this.#machineTierMapMemoryLimit + VMM_OVERHEAD_MIB) * 1024 * 1024;

      const args = [];

      args.push("--exec-file", this.#dependencies.firecracker);
      args.push("--chroot-base-dir", join(this.#environment.root, "jailer"));
      args.push("--netns", `/var/run/netns/${ns.name}`);
      args.push("--uid", String(JAIL_UID));
      args.push("--gid", String(JAIL_GID));
      args.push("--id", this.#id);

      await readFile("/sys/fs/cgroup/cgroup.controllers", "utf-8").then(
        () => {
          args.push("--cgroup-version", "2");
          args.push("--cgroup", `cpu.max=${cpuQuotaUs} ${cpuPeriodUs}`);
          args.push("--cgroup", `memory.max=${totalMemoryBytes}`);
        },
        () => {
          args.push("--cgroup", `cpu.cfs_quota_us=${cpuQuotaUs}`);
          args.push("--cgroup", `cpu.cfs_period_us=${cpuPeriodUs}`);
          args.push("--cgroup", `memory.limit_in_bytes=${totalMemoryBytes}`);
        },
      );

      args.push("--");
      args.push("--api-sock", "/firecracker.sock");

      return args;
    }

    async #buildBootArgs() {
      const bootArgs = [] as string[];

      bootArgs.push("console=ttyS0");
      bootArgs.push("reboot=k");
      bootArgs.push("panic=1");

      bootArgs.push(`ip=${VMNet.TAP_VM_IP}:${VMNet.TAP_NS_IP}:${VMNet.TAP_NS_IP}:255.255.255.0::eth0:off`);

      if (process.arch === "arm64") {
        bootArgs.push("keep_bootcon");
      }

      bootArgs.push("init=/init");

      bootArgs.push("quiet");
      bootArgs.push("loglevel=3");

      return bootArgs;
    }

    async #sleep(delay: number, signal?: AbortSignal) {
      return new Promise<void>((resolve) => {
        const handle = () => {
          resolve();

          timer.close();
          signal?.removeEventListener("abort", handle);
        };

        const timer = setTimeout(handle, delay);

        signal?.addEventListener("abort", handle);
      });
    }

    async #setup(socket: string, process: ProcessPromise, cb: (fc: Firecracker, signal: AbortSignal) => Promise<void>) {
      this.#logger.info("Waiting for jailer process to enter running state...");

      while (true) {
        if (process.signal.aborted) {
          return this.#logger.warn("Aborted while waiting for jailer process to start");
        }

        if (process.stage === "rejected" || process.stage === "fulfilled") {
          return this.#logger.warn("Jailer process exited before becoming ready", { stage: process.stage });
        }

        if (process.stage === "running") {
          break;
        }

        await this.#sleep(10, process.signal);
      }

      let attempts = 0;

      this.#logger.info("Waiting for Firecracker API socket to become available...");

      while (true) {
        if (process.signal.aborted) {
          return this.#logger.warn("Aborted while waiting for Firecracker socket");
        }

        if (process.stage !== "running") {
          return this.#logger.warn("Jailer process ended while waiting for Firecracker socket");
        }

        const result = await new Promise<{ ok: true } | { ok: false; e: unknown }>((resolve) => {
          const connection = createConnection({ path: socket });

          const cleanup = (result: { ok: true } | { ok: false; e: unknown }) => {
            connection.removeAllListeners();
            connection.destroy();

            resolve(result);
          };

          connection.once("connect", () => {
            cleanup({ ok: true });
          });

          connection.once("error", (e) => {
            cleanup({ ok: false, e });
          });
        });

        if (result.ok) {
          this.#logger.info(`Firecracker API socket is ready. (attempts=${attempts})`);
          break;
        } else {
          this.#logger.debug(`Firecracker socket not ready yet, retrying... (attempts=${attempts})`);

          if (attempts >= 10) {
            throw result.e;
          }

          attempts += 1;

          await this.#sleep(100, process.signal);
        }
      }

      const fc = new Firecracker(socket);

      const args = await this.#buildBootArgs();

      this.#logger.debug(`Boot arguments: "${args.join(" ")}". Configuring Firecracker instance ...`);

      const results = await Promise.allSettled([
        fc.putLogger({ log_path: "./firecracker.log", level: "Debug", show_level: true, show_log_origin: true }),
        fc.putGuestNetworkInterfaceById("eth0", { iface_id: "eth0", guest_mac: this.#mac, host_dev_name: VMNet.TAP }),
        fc.putMmdsConfig({ version: "V2", network_interfaces: ["eth0"], ipv4_address: "169.254.169.254", imds_compat: false }),
        fc.putMmds({ latest: { "meta-data": this.#metadata ?? {} } }),
        fc.putMachineConfiguration({
          cpu_template: "None",
          mem_size_mib: this.#machineTierMapMemoryLimit,
          vcpu_count: this.#machineTierMapCpuCapacity > 1 ? Math.ceil(this.#machineTierMapCpuCapacity / 2) * 2 : 1,
          track_dirty_pages: false,
          smt: false,
        }),
        fc.putGuestBootSource({
          kernel_image_path: "./kernel",
          boot_args: args.join(" "),
        }),
        fc.putGuestDriveById("runtime", {
          drive_id: "runtime",
          path_on_host: "./runtime.squashfs",
          is_root_device: true,
          is_read_only: true,
          cache_type: "Writeback",
          io_engine: "Async",
        }),
        fc.putGuestDriveById("scratch", {
          drive_id: "scratch",
          path_on_host: "./scratch.ext4",
          is_root_device: false,
          is_read_only: false,
          cache_type: "Writeback",
          io_engine: "Async",
        }),
      ]);

      for (const [_, result] of results.entries()) {
        if (result.status === "rejected") {
          this.#logger.error("Firecracker configuration step failed", { err: result.reason });
        }
      }

      const failed = results.find((result) => result.status === "rejected");

      if (failed && failed.status === "rejected") {
        throw failed.reason;
      }

      await cb(fc, process.signal);

      this.#logger.info("Starting Firecracker instance ...");

      await fc.createSyncAction({ action_type: "InstanceStart" });
    }

    async run(signal: AbortSignal, cb: (signal: AbortSignal, resources: VMManager.VM.Resources) => Promise<void>) {
      signal.throwIfAborted();

      const ns = await this.#net.random();

      this.#logger.info("Network namespace allocated", { netns: ns.name, slot: ns.slot });

      const root = join(this.#environment.root, "jailer", basename(this.#dependencies.firecracker), this.#id, "root");
      const controller = new AbortController();

      const abort = controller.abort.bind(controller);

      signal.addEventListener("abort", abort);

      try {
        // 每次运行前彻底清理旧的 root 目录，避免遗留的 /dev/net/tun 等设备节点
        // 导致 jailer 在 mknod 时报告 EEXIST (File exists, os error 17)。
        await rm(root, { recursive: true, force: true });
        await mkdir(root, { recursive: true });

        this.#logger.info("Preparing jail root filesystem", { root });

        await cp(this.#kernel.path, join(root, "kernel"));
        await cp(this.#image.runtime, join(root, "runtime.squashfs"));

        this.#logger.debug("Copied kernel and runtime image into jail root");

        await this.#image.createScratchFS(join(root, "scratch.ext4"));

        this.#logger.debug("Created writable scratch filesystem");

        await chown(root, JAIL_UID, JAIL_GID);
        await chown(join(root, "kernel"), JAIL_UID, JAIL_GID);
        await chown(join(root, "runtime.squashfs"), JAIL_UID, JAIL_GID);
        await chown(join(root, "scratch.ext4"), JAIL_UID, JAIL_GID);

        this.#logger.info("Jail root filesystem ownership adjusted");

        const args = await this.#buildArgs(ns);
        const shell = $({ halt: true, signal: controller.signal });
        const process = shell`${this.#dependencies.jailer} ${args}`.nothrow().run();

        const stderrLogger = this.#logger.namespace("STDERR");
        const stdoutLogger = this.#logger.namespace("STDOUT");

        this.#logger.info("Launching jailer process.", { args: args.join(" ") });

        if (process.stderr) {
          createReadLineInterface(process.stderr).on("line", (line) => {
            stderrLogger.info(line);
          });
        } else {
          stderrLogger.warn("No stderr stream available");
        }

        if (process.stdout) {
          createReadLineInterface(process.stdout).on("line", (line) => {
            stdoutLogger.info(line);
          });
        } else {
          stdoutLogger.warn("No stdout stream available");
        }

        this.#setup(join(root, "firecracker.sock"), process, (fc, signal) => cb(signal, { firecracker: fc, net: ns, process, root })).catch(
          (error) => {
            this.#logger.error("VM setup failed", { error });
            controller.abort(error);
          },
        );

        await process.then((result) => {
          this.#logger.info("Jailer process exited. ", { code: result.exitCode, signal: result.signal, duration: result.duration });
        });
      } finally {
        await this.#net.release(ns).catch(() => {});
        await rm(root, { recursive: true, force: true }).catch(() => {});

        signal.removeEventListener("abort", abort);

        this.#logger.info("Jail root directory cleaned up");
      }
    }
  }

  export namespace VM {
    export type Options = {
      id: string;
      machineTier: "minimal" | "standard" | "performance";
      metadata: Record<string, unknown>;
      environment: Environment;
      logger: Logger;
      image: VMImage;
      kernel: VMKernel;
      net: VMNet;
      dependencies: Dependencies;
    };

    export type Resources = {
      readonly firecracker: Firecracker;
      readonly root: string;
      readonly net: VMNet.Namespace;
      readonly process: ProcessPromise;
    };
  }

  export const CPU_CFS_PERIOD_US = 100000;
  export const VMM_OVERHEAD_MIB = 64;

  /**
   * jailer 在 exec firecracker 后降权运行的用户/组 ID。
   * 必须与 root 目录中文件的属主保持一致，否则 firecracker 无法读写
   * scratch.ext4 等耗材（报 Permission denied (os error 13)）。
   */
  export const JAIL_UID = 1000;
  export const JAIL_GID = 1000;
}
