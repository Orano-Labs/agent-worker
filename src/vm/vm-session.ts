import { exec, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { asError } from "catch-unknown";
import { NodeSSH, type Config as NodeSSHConfig } from "node-ssh";
import { Firecracker } from "@/vm/service/firecracker";
import { VM } from "@/vm/vm";
import { VMNet } from "@/vm/vm-net";

export class VMSession {
  #vm: VM;

  constructor(vm: VM) {
    this.#vm = vm;
  }

  pid() {
    if (!existsSync(join(this.#vm.root, "firecracker.pid"))) {
      return null;
    }

    return Number.parseInt(readFileSync(join(this.#vm.root, "firecracker.pid"), "utf-8"), 10);
  }

  process() {
    const pid = this.pid();

    if (!pid) {
      return null;
    }

    if (!existsSync(`/proc/${pid}`)) {
      return null;
    }

    const stats = statSync(`/proc/${pid}`);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    const status = readFileSync(`/proc/${pid}/status`, "utf-8");

    const vmrss = status.match(/VmRSS:\s+(\d+)/)?.[1];
    const vmsize = status.match(/VmSize:\s+(\d+)/)?.[1];

    return {
      pid,
      startTime: stats.birthtime,
      cmdline: cmdline.replace(/\0/g, " "),
      memoryRSSMB: vmrss ? Number.parseInt(vmrss) / 1024 : null,
      memoryVirtualMB: vmsize ? Number.parseInt(vmsize) / 1024 : null,
    };
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

  async start() {
    if (this.process()) {
      return;
    }

    for (const item of ["/dev", "/run", "/sys", "/firecracker.pid"]) {
      await this.#exec(`sudo rm -rf ${join(this.#vm.root, item)}`).catch(() => {});
    }

    const args = [this.#vm.controller.jailer];

    args.push("--exec-file", this.#vm.controller.firecracker);
    args.push("--chroot-base-dir", this.#vm.controller.chroot);
    args.push("--netns", `/var/run/netns/${this.#vm.net.name}`);
    args.push("--gid", `${this.#vm.controller.gid}`);
    args.push("--uid", `${this.#vm.controller.uid}`);
    args.push("--id", `${this.#vm.id}`);

    args.push("--daemonize");

    let version = 1;

    try {
      readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf-8");
      version = 2;
    } catch {}

    const cpuPeriodUs = VM.CPU_CFS_PERIOD_US;
    const cpuQuotaUs = this.#vm.cpus * VM.CPU_CFS_PERIOD_US;

    const memoryLimitBytes = (this.#vm.memory + VM.VMM_OVERHEAD_MIB) * 1024 * 1024;

    if (version === 2) {
      args.push("--cgroup-version", "2");
      args.push("--cgroup", `cpu.max=${cpuQuotaUs} ${cpuPeriodUs}`);
      args.push("--cgroup", `memory.max=${memoryLimitBytes}`);
    } else {
      args.push("--cgroup", `cpu.cfs_quota_us=${cpuQuotaUs}`);
      args.push("--cgroup", `cpu.cfs_period_us=${cpuPeriodUs}`);
      args.push("--cgroup", `memory.limit_in_bytes=${memoryLimitBytes}`);
    }

    const child = spawn("sudo", args, { stdio: "inherit" });

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });

      child.on("error", (err) => {
        reject(new Error(`Failed to start process: ${err.message}`));
      });
    });

    const fc = await this.connect();

    await fc.setLogger({
      log_path: "./firecracker.log",
      level: "Debug",
      show_level: true,
      show_log_origin: true,
    });

    await fc.setMachineConfiguration({
      vcpu_count: this.#vm.cpus,
      mem_size_mib: this.#vm.memory,
      cpu_template: "None",
      track_dirty_pages: true,
      smt: false,
    });

    await fc.setBootSource({
      kernel_image_path: "./kernel",
      boot_args: `console=ttyS0 reboot=k panic=1 ip=${VMNet.TAP_VM_IP}:${VMNet.TAP_NS_IP}:${VMNet.TAP_NS_IP}:255.255.255.0::eth0:off ${process.arch === "arm64" ? "keep_bootcon" : ""} quiet loglevel=0`,
    });

    await fc.setDrive("rootfs", {
      drive_id: "rootfs",
      path_on_host: "./rootfs.ext4",
      is_root_device: true,
      is_read_only: false,
      cache_type: "Unsafe",
      io_engine: "Sync",
    });

    await fc.setNetworkInterface("net1", {
      iface_id: "net1",
      guest_mac: this.#vm.mac,
      host_dev_name: VMNet.TAP,
    });

    await fc.setMmdsConfig({
      version: "V2",
      network_interfaces: ["net1"],
      ipv4_address: "169.254.169.254",
      imds_compat: false,
    });

    await fc.setMmds({
      hello: "Hello!!",
    });

    await fc.createSyncAction({
      action_type: "InstanceStart",
    });
  }

  async stop() {
    if (!this.process()) {
      return;
    }

    await this.#exec(
      `ssh -i ${join(this.#vm.root, "id_rsa")} -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=2 root@${this.#vm.net.veth.guest.ip} "poweroff -f"`,
    ).catch(() => {});

    const timeout = 10000;
    const interval = 500;
    const maxAttempts = timeout / interval;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, interval));

      if (!this.process()) {
        return;
      }
    }

    const pid = this.pid();

    if (!pid) {
      return;
    }

    try {
      await this.#exec(`sudo kill -9 ${pid}`).catch(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      });
    } catch {}
  }

  async connect() {
    const socket = join(this.#vm.root, "run", "firecracker.socket");
    const timeout = AbortSignal.timeout(1000 * 10);

    await new Promise<void>((resolve, reject) => {
      let error: unknown;

      const attempt = () => {
        if (timeout.aborted) {
          return reject(
            new Error(`Socket ${socket} not ready after 10s.${error ? ` Last error: ${asError(error).message}` : ""}`),
          );
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

    return new Firecracker(socket);
  }

  async ssh() {
    const ssh = new NodeSSH();
    const timeout = AbortSignal.timeout(1000 * 10);

    const config: NodeSSHConfig = {
      host: this.#vm.ip,
      username: "root",
      privateKeyPath: join(this.#vm.root, "id_rsa"),
    };

    let error: unknown;

    const attempt = async (): Promise<NodeSSH> => {
      if (timeout.aborted) {
        throw new Error(
          `SSH connection timed out after 10s for VM ${this.#vm.id}.${error ? ` Last error: ${asError(error).message}` : ""}`,
        );
      }

      try {
        return await ssh.connect(config);
      } catch (e) {
        error = e;

        return attempt();
      }
    };

    return attempt();
  }
}

export namespace VMSession {}
