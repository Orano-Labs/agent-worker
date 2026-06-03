import { exec, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createInterface as createReadLineInterface } from "node:readline";

import { asError } from "catch-unknown";

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

  async #exec(command: string, timeout = 0) {
    return new Promise<string>((resolve, reject) => {
      exec(command, { timeout }, (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async run() {
    const id = crypto.randomUUID();
    const user = userInfo();
    const net = await this.#net.random();
    const cpus = 1;
    const mem = 512;

    const args = [this.#env.jailer];

    args.push("--exec-file", this.#env.firecracker);
    args.push("--chroot-base-dir", join(this.#env.workdir, "sessions"));
    args.push("--netns", `/var/run/netns/${net.name}`);
    args.push("--gid", `${user.gid}`);
    args.push("--uid", `${user.uid}`);
    args.push("--id", `${id}`);

    const CPU_CFS_PERIOD_US = 100000;
    const VMM_OVERHEAD_MIB = 64;

    let version = 1;

    try {
      readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf-8");
      version = 2;
    } catch {}

    const cpuPeriodUs = CPU_CFS_PERIOD_US;
    const cpuQuotaUs = cpus * CPU_CFS_PERIOD_US;

    const memoryLimitBytes = (mem + VMM_OVERHEAD_MIB) * 1024 * 1024;

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
    args.push("--api-sock", "/api.sock");

    const root = join(this.#env.workdir, "sessions", "firecracker", id, "root");

    await mkdir(root, { recursive: true });

    await cp(this.#env.kernel, join(root, "kernel"));
    await cp(this.#image.base, join(root, "rootfs"));

    const stdout = createWriteStream(join(root, "stdout.log"));
    const stderr = createWriteStream(join(root, "stderr.log"));

    const child = spawn("sudo", args, { stdio: ["inherit", "pipe", "pipe"] });

    createReadLineInterface(child.stderr).on("line", (line) => {
      this.#logger.debug(line);
      stderr.write(`${line}\n`);
    });

    createReadLineInterface(child.stdout).on("line", (line) => {
      this.#logger.debug(line);
      stdout.write(`${line}\n`);
    });

    await new Promise<void>((resolve, reject) => {
      child.on("spawn", () => {
        resolve();
      });

      child.on("error", (err) => {
        reject(new Error(`Failed to start process: ${err.message}`));
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
    });

    const socket = join(root, "api.sock");
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

    await fc.setLogger({
      log_path: "./firecracker.log",
      level: "Debug",
      show_level: true,
      show_log_origin: true,
    });

    // await fc.setMachineConfiguration({
    //   vcpu_count: cpus,
    //   mem_size_mib: mem,
    //   cpu_template: "None",
    //   track_dirty_pages: true,
    //   smt: false,
    // });

    await fc.setBootSource({
      kernel_image_path: "./kernel",
      boot_args: `console=ttyS0 reboot=k panic=1 ip=${Network.TAP_VM_IP}:${Network.TAP_NS_IP}:${Network.TAP_NS_IP}:255.255.255.0::eth0:off ${process.arch === "arm64" ? "keep_bootcon" : ""} init=/init`,
    });

    await fc.setDrive("rootfs", {
      drive_id: "rootfs",
      path_on_host: "./rootfs",
      is_root_device: true,
      is_read_only: false,
      cache_type: "Unsafe",
      io_engine: "Sync",
    });

    const mac = (() => {
      const hash = createHash("sha256").update(id).digest();
      const bytes: string[] = [];

      for (let i = 0; i < 5; i++) {
        bytes.push(hash[i].toString(16).padStart(2, "0"));
      }

      return `02:${bytes.join(":")}`;
    })();

    await fc.setNetworkInterface("net1", {
      iface_id: "net1",
      guest_mac: mac,
      host_dev_name: Network.TAP,
    });

    await fc.createSyncAction({
      action_type: "InstanceStart",
    });
  }
}

export namespace Orchestrator {}
