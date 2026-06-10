import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { createInterface as createReadLineInterface } from "node:readline";
import { asError } from "catch-unknown";
import { customAlphabet } from "nanoid";
import { alphanumeric } from "nanoid-dictionary";

import { Container } from "@/helpers/container";
import { Firecracker } from "@/helpers/firecracker";
import { Environment } from "@/internal/environment";
import { Image } from "@/internal/image";
import { Logger } from "@/internal/logger";
import { Network } from "@/internal/network";

export class Orchestrator {
  #env: Environment;
  #logger: Logger;
  #net: Network;
  #image: Image;

  constructor() {
    this.#env = Container.inject(Environment);
    this.#logger = Container.inject(Logger).scope("Orchestrator");
    this.#net = Container.inject(Network);
    this.#image = Container.inject(Image);
  }

  async create(options?: Orchestrator.VMOptions) {
    const id = customAlphabet(alphanumeric, 12)();
    const user = userInfo();
    const net = await this.#net.random();
    const mac = (() => {
      const hash = createHash("sha256").update(id).digest();
      const bytes: string[] = [];

      for (let i = 0; i < 5; i++) {
        bytes.push(hash[i].toString(16).padStart(2, "0"));
      }

      return `02:${bytes.join(":")}`;
    })();

    const cpuCapacity = options?.cpuCapacity ?? 4;
    const memory = options?.memory ?? 1024;

    const args = [this.#env.jailer];

    args.push("--exec-file", this.#env.firecracker);
    args.push("--chroot-base-dir", join(this.#env.workdir, "jailer"));
    args.push("--netns", `/var/run/netns/${net.name}`);
    args.push("--gid", `${user.gid}`);
    args.push("--uid", `${user.uid}`);
    args.push("--id", `${id}`);

    const CPU_CFS_PERIOD_US = 100000;
    const VMM_OVERHEAD_MIB = 64;

    let version = 2;

    try {
      await readFile("/sys/fs/cgroup/cgroup.controllers", "utf-8");
    } catch {
      version = 1;
    }

    const cpuPeriodUs = CPU_CFS_PERIOD_US;
    const cpuQuotaUs = cpuCapacity * CPU_CFS_PERIOD_US;

    const memoryLimitBytes = (memory + VMM_OVERHEAD_MIB) * 1024 * 1024;

    if (version === 2) {
      args.push("--cgroup-version", "2");
      args.push("--cgroup", `cpu.max=${cpuQuotaUs} ${cpuPeriodUs}`);
      args.push("--cgroup", `memory.max=${memoryLimitBytes}`);
    } else {
      args.push("--cgroup", `cpu.cfs_quota_us=${cpuQuotaUs}`);
      args.push("--cgroup", `cpu.cfs_period_us=${cpuPeriodUs}`);
      args.push("--cgroup", `memory.limit_in_bytes=${memoryLimitBytes}`);
    }

    args.push("--");
    args.push("--api-sock", "/firecracker.sock");

    const root = join(this.#env.workdir, "jailer", basename(this.#env.firecracker), id, "root");

    let pid: number | undefined;

    try {
      await mkdir(root, { recursive: true });

      await cp(this.#env.kernel, join(root, "kernel"));
      await cp(this.#image.runtime, join(root, "runtime.squashfs"));

      await this.#image.createScratchFS(join(root, "scratch.ext4"));

      const stdout = createWriteStream(join(root, "firecracker.stdout"));
      const stderr = createWriteStream(join(root, "firecracker.stderr"));

      const child = spawn("sudo", args, { stdio: ["inherit", "pipe", "pipe"] });

      pid = child.pid;

      createReadLineInterface(child.stderr).on("line", (line) => {
        if (process.env.NODE_ENV !== "production") {
          this.#logger.debug(line);
        }

        stderr.write(`${line}\n`);
      });

      createReadLineInterface(child.stdout).on("line", (line) => {
        if (process.env.NODE_ENV !== "production") {
          this.#logger.debug(line);
        }

        stdout.write(`${line}\n`);
      });

      await new Promise<void>((resolve, reject) => {
        child.on("spawn", resolve);
        child.on("error", reject);
      });

      child.on("close", (code) => {
        stderr.end();
        stdout.end();

        if (code === 0) {
          this.#logger.info("vm has shut down cleanly.");
        } else {
          this.#logger.warn(`terminated unexpectedly with exit code ${code}.`);
        }
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

            // this.#logger.errorFrom(e, "xxx");

            error = e;
          });
        };

        attempt();
      });

      const fc = new Firecracker(socket);

      await Promise.all([
        fc.putLogger({ log_path: "./firecracker.log", level: "Debug", show_level: true, show_log_origin: true }),
        fc.putGuestNetworkInterfaceById("eth0", { iface_id: "eth0", guest_mac: mac, host_dev_name: Network.TAP }),
        fc.putMmdsConfig({ version: "V2", network_interfaces: ["eth0"], ipv4_address: "169.254.169.254", imds_compat: false }),
        fc.putMmds({ latest: { "meta-data": options?.metadata ?? {} } }),
        fc.putMachineConfiguration({
          cpu_template: "None",
          mem_size_mib: memory,
          vcpu_count: cpuCapacity > 1 ? Math.ceil(cpuCapacity / 2) * 2 : 1,
          track_dirty_pages: false,
          smt: false,
          huge_pages: "2M",
        }),
        fc.putGuestBootSource({
          kernel_image_path: "./kernel",
          boot_args: `console=ttyS0 reboot=k panic=1 ip=${Network.TAP_VM_IP}:${Network.TAP_NS_IP}:${Network.TAP_NS_IP}:255.255.255.0::eth0:off ${process.arch === "arm64" ? "keep_bootcon" : ""} init=/init`,
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

      await fc.getExportVmConfig().then((resp) => {
        this.#logger.info("Full vm config", resp?.data);
      });

      await fc.createSyncAction({
        action_type: "InstanceStart",
      });

      const vm: Orchestrator.VM = {
        id,
        ip: net.veth.host.ip,
        root,
        chroot: join(this.#env.workdir, "firecracker", id),
        fc,
        abortController: new AbortController(),
      };

      return vm;
    } catch (error) {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          //
        }
      }
      await this.#net.release(net).catch(() => {});
      await rm(join(this.#env.workdir, basename(this.#env.firecracker), id)).catch(() => {});
      throw error;
    }
  }
}

export namespace Orchestrator {
  export type VM = {
    id: string;
    abortController: AbortController;
    ip: string;
    root: string;
    chroot: string;
    fc: Firecracker;
  };

  export type VMOptions = {
    cpuCapacity?: number;
    memory?: number;
    metadata?: Record<string, unknown>;
  };
}
