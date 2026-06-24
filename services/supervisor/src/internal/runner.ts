import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { createInterface as createReadLineInterface } from "node:readline";

import type { Readable } from "node:stream";
import { asError } from "catch-unknown";
import { Container } from "@/helpers/container";
import { Firecracker } from "@/helpers/firecracker";
import { Environment } from "@/internal/environment";
import { Image } from "@/internal/image";
import { Logger } from "@/internal/logger";
import { Network } from "@/internal/network";
import type { Orchestrator } from "./orchestrator";

const CPU_CFS_PERIOD_US = 100000;
const VMM_OVERHEAD_MIB = 64;

export class Runner {
  #env: Environment;
  #logger: Logger;
  #image: Image;

  constructor() {
    this.#env = Container.inject(Environment);
    this.#logger = Container.inject(Logger).scope("Runner");
    this.#image = Container.inject(Image);
  }

  async create(options: Runner.Options) {
    const mac = (() => {
      const hash = createHash("sha256").update(options.id).digest();
      const bytes: string[] = [];

      for (let i = 0; i < 5; i++) {
        bytes.push(hash[i].toString(16).padStart(2, "0"));
      }

      return `02:${bytes.join(":")}`;
    })();

    const logger = this.#logger.scope(options.id);
    const root = join(this.#env.workdir, "jailer", basename(this.#env.firecracker), options.id, "root");

    const memoryLimitMIB = options.config.machineTier === "minimal" ? 1024 : options.config.machineTier === "standard" ? 2048 : 4096;
    const cpuCapacity = options.config.machineTier === "minimal" ? 1 : options.config.machineTier === "standard" ? 2 : 4;
    const cpuPeriodUs = CPU_CFS_PERIOD_US;
    const cpuQuotaUs = cpuCapacity * CPU_CFS_PERIOD_US;

    const totalMemoryBytes = (memoryLimitMIB + VMM_OVERHEAD_MIB) * 1024 * 1024;

    let ps: ChildProcessByStdio<null, Readable, Readable> | undefined;

    try {
      await mkdir(root, { recursive: true });

      await cp(this.#env.kernel, join(root, "kernel"));
      await cp(this.#image.runtime, join(root, "runtime.squashfs"));

      await this.#image.createScratchFS(join(root, "scratch.ext4"));

      const stdout = createWriteStream(join(root, "firecracker.stdout"));
      const stderr = createWriteStream(join(root, "firecracker.stderr"));

      const user = userInfo();
      const args = [this.#env.jailer];

      args.push("--exec-file", this.#env.firecracker);
      args.push("--chroot-base-dir", join(this.#env.workdir, "jailer"));
      args.push("--netns", `/var/run/netns/${options.net.name}`);
      args.push("--uid", `${user.uid}`);
      args.push("--gid", `${user.gid}`);
      args.push("--id", options.id);

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

      ps = spawn("sudo", args, { stdio: ["inherit", "pipe", "pipe"] });

      createReadLineInterface(ps.stderr).on("line", (line) => {
        if (process.env.NODE_ENV !== "production") {
          logger.debug(line);
        }

        stderr.write(`${line}\n`);
      });

      createReadLineInterface(ps.stdout).on("line", (line) => {
        if (process.env.NODE_ENV !== "production") {
          logger.debug(line);
        }

        stdout.write(`${line}\n`);
      });

      await new Promise<void>((resolve, reject) => {
        ps!.on("spawn", resolve);
        ps!.on("error", reject);
      });

      const socket = join(root, "firecracker.sock");
      const timeoutSignal = AbortSignal.timeout(1000 * 2);

      await new Promise<void>((resolve, reject) => {
        let error: unknown;

        const attempt = () => {
          if (timeoutSignal.aborted) {
            return reject(new Error(`Socket ${socket} not ready.${error ? ` Last error: ${asError(error).message}` : ""}`));
          }

          const connection = createConnection({ path: socket });

          const cleanup = () => {
            connection.removeAllListeners();
            connection.destroy();
          };

          connection.once("connect", () => {
            cleanup();
            resolve();
          });

          connection.once("error", (e) => {
            cleanup();
            setTimeout(attempt, 50);

            error = e;
          });
        };

        attempt();
      });

      const fc = new Firecracker(socket);
      const bootArgs = [] as string[];

      const fs = {
        password: Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex"),
      };

      bootArgs.push("console=ttyS0");
      bootArgs.push("reboot=k");
      bootArgs.push("panic=1");

      bootArgs.push(`ip=${Network.TAP_VM_IP}:${Network.TAP_NS_IP}:${Network.TAP_NS_IP}:255.255.255.0::eth0:off`);

      if (process.arch === "arm64") {
        bootArgs.push("keep_bootcon");
      }

      bootArgs.push("init=/init");

      bootArgs.push(`AW_RUNNER_ID=${options.id}`);
      bootArgs.push(`AW_RUNNER_FS_PASSWORD=${fs.password}`);
      bootArgs.push(`AW_RUNNER_PROJECT=${options.config.projectId}`);

      bootArgs.push("quiet");
      bootArgs.push("loglevel=3");

      await Promise.all([
        fc.putLogger({ log_path: "./firecracker.log", level: "Debug", show_level: true, show_log_origin: true }),
        fc.putGuestNetworkInterfaceById("eth0", { iface_id: "eth0", guest_mac: mac, host_dev_name: Network.TAP }),
        fc.putMmdsConfig({ version: "V2", network_interfaces: ["eth0"], ipv4_address: "169.254.169.254", imds_compat: false }),
        fc.putMmds({ latest: { "meta-data": options.config.metadata ?? {} } }),
        fc.putMachineConfiguration({
          cpu_template: "None",
          mem_size_mib: memoryLimitMIB,
          vcpu_count: cpuCapacity > 1 ? Math.ceil(cpuCapacity / 2) * 2 : 1,
          track_dirty_pages: false,
          smt: false,
          huge_pages: "2M",
        }),
        fc.putGuestBootSource({
          kernel_image_path: "./kernel",
          boot_args: bootArgs.join(" "),
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

      logger.info("MicroVM initialized and boot sequence started successfully.");

      ps.on("close", (code, signal) => {
        stderr.end();
        stdout.end();

        if (code === 0) {
          logger.info("VM has shut down cleanly.");
        } else if (signal) {
          logger.warn(`VM was terminated unexpectedly by signal: ${signal}`);
        } else {
          logger.warn(`VM terminated unexpectedly with exit code ${code}.`);
        }
      });

      const instance: Runner.Instance = {
        process: ps,
        fc,
        root,
        fs,
      };

      return instance;
    } catch (error) {
      if (ps) {
        try {
          ps.kill("SIGKILL");
        } catch (error) {
          //
        }
      }

      throw error;
    }
  }
}

export namespace Runner {
  export type Options = {
    readonly id: string;
    readonly net: Network.Namespace;
    readonly config: Orchestrator.TaskConfig;
  };

  export type Instance = {
    readonly process: ChildProcessByStdio<null, Readable, Readable>;
    readonly fc: Firecracker;
    readonly root: string;
    readonly fs: Record<"password", string>;
  };
}
