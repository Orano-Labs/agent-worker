import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VMController } from "@/vm/vm-controller";
import { VMNet } from "@/vm/vm-net";
import { VMSession } from "@/vm/vm-session";

export class VM {
  #controller: VMController;
  #id: string;
  #row?: {
    readonly state: "active" | "archived";
    readonly cpus: number;
    readonly memory: number;
    readonly disk: number;
    readonly net_slot: number;
    readonly net_bandwidth: number | null;
    readonly image: string | null;
  };

  #session: VMSession;
  #net: VMNet;

  constructor(controller: VMController, id: string) {
    this.#controller = controller;
    this.#id = id;
    this.#net = new VMNet(this.row.net_slot);
    this.#session = new VMSession(this);
  }

  get #chroot() {
    return join(this.#controller.root, "vms");
  }

  get row() {
    if (this.#row) {
      return this.#row;
    }

    const row = this.#controller.db.prepare("SELECT * FROM vm_configs WHERE id = ?").get(this.#id);

    if (!row) {
      throw new Error(`VM with id "${this.#id}" not found in database.`);
    }

    // @ts-expect-error
    this.#row = Object.freeze({
      state: row.state,
      cpus: row.cpus,
      memory: row.memory,
      disk: row.disk,
      net_slot: row.net_slot,
      net_bandwidth: row.net_bandwidth,
      image: row.image,
    });

    return this.#row!;
  }

  get mac() {
    const hash = createHash("sha256").update(this.#id).digest();
    const bytes: string[] = [];

    for (let i = 0; i < 5; i++) {
      bytes.push(hash[i].toString(16).padStart(2, "0"));
    }

    return `02:${bytes.join(":")}`;
  }

  get root() {
    return join(this.#chroot, "firecracker", this.#id, "root");
  }

  get cpus() {
    return this.row.cpus;
  }

  get memory() {
    return this.row.memory;
  }

  get disk() {
    return this.row.disk;
  }

  get image() {
    return join(this.#controller.root, "images", `${this.row.image || "ubuntu"}.squashfs`);
  }

  get session() {
    return this.#session;
  }

  get controller() {
    return this.#controller;
  }

  get id() {
    return this.#id;
  }

  get net() {
    return this.#net;
  }

  get ip() {
    return this.#net.veth.guest.ip;
  }

  async #exec(command: string, timeout = 0) {
    return new Promise<string>((resolve, reject) => {
      exec(command, { timeout }, (err, stdout, stderr) => {
        if (err) {
          reject(err);
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async #transaction<T>(callback: () => Promise<T>) {
    try {
      this.#controller.db.exec("BEGIN EXCLUSIVE TRANSACTION");
      const result = await callback();
      this.#controller.db.exec("COMMIT");

      return result;
    } catch (error) {
      if (this.#controller.db.isTransaction) {
        this.#controller.db.exec("ROLLBACK");
      }

      throw error;
    }
  }

  async #prepare() {
    const kernel = join(this.root, "kernel");
    const fs = join(this.root, "rootfs.ext4");

    if (!existsSync(kernel)) {
      if (!existsSync(this.#controller.vmlinux)) {
        throw new Error("Default kernel not found. Please download it first.");
      }

      linkSync(this.#controller.vmlinux, kernel);
    }

    if (!existsSync(fs)) {
      if (!existsSync(this.image)) {
        if (this.row.image && this.row.image !== "ubuntu") {
          throw new Error("Default image not found. Please download it first.");
        } else {
          throw new Error(`Image ${this.row.image} not found.`);
        }
      }

      const tmp = join(tmpdir(), `vm-${crypto.randomUUID()}`);

      try {
        const commands = [
          `unsquashfs -d ${tmp} ${this.image}`,
          `ssh-keygen -q -t rsa -b 2048 -f ${join(this.root, "id_rsa")} -N ""`,
          `mkdir -p ${join(tmp, "root/.ssh")}`,
          `cp ${join(this.root, "id_rsa.pub")} ${join(tmp, "root/.ssh/authorized_keys")}`,
          `echo "nameserver 8.8.8.8" > ${join(tmp, "etc/resolv.conf")}`,
          `echo "nameserver 1.1.1.1" >> ${join(tmp, "etc/resolv.conf")}`,
          `echo "nameserver 223.5.5.5" >> ${join(tmp, "etc/resolv.conf")}`,
          `sudo chown -R root:root ${tmp}`,
          `truncate -s ${this.disk}MB ${fs}`,
          `sudo mkfs.ext4 -d ${tmp} -F ${fs}`,
        ];

        mkdirSync(tmp, { recursive: true });

        for (const command of commands) {
          await this.#exec(command).then(console.log);
        }
      } finally {
        await this.#exec(`sudo rm -rf ${tmp}`).catch(() => {});
      }
    }
  }

  async run() {
    if (this.row.state === "archived") {
      throw new Error("Cannot run an archived VM.");
    }

    if (this.#session.process()) {
      return;
    }

    try {
      await this.#prepare();
      await this.#net.uninstall();
      await this.#net.install();
      await this.#session.start();
    } catch (error) {
      await this.#net.uninstall();

      throw error;
    }
  }

  async stop() {
    await this.#session.stop();
    await this.#net.uninstall();
  }

  async archive() {
    if (this.row.state === "archived") {
      return;
    }

    if (this.#session.process()) {
      throw new Error(`Cannot archive VM "${this.#id}" while it is running. Stop it first.`);
    }

    await this.#transaction(async () => {
      this.#controller.db
        .prepare(
          `UPDATE vm_configs SET state = 'archived', updated_at = STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW') WHERE id = ?`,
        )
        .run(this.id);
    });

    this.#row = undefined;
  }

  async health() {
    if (!this.#session.process()) {
      return { ok: false, stage: "process" } satisfies VM.Health;
    }

    const vmm = await this.#session
      .connect()
      .then((fc) => {
        return fc.getInstanceInformation();
      })
      .then(
        () => true,
        () => false,
      );

    if (!vmm) {
      return { ok: false, stage: "vmm" } satisfies VM.Health;
    }

    const guest = await this.#exec(`nc -z -w 1 ${this.ip} 22`).then(
      () => true,
      () => false,
    );

    if (!guest) {
      return { ok: false, stage: "guest" } satisfies VM.Health;
    }

    return { ok: true } satisfies VM.Health;
  }
}

export namespace VM {
  export const CPU_CFS_PERIOD_US = 100000;
  export const VMM_OVERHEAD_MIB = 64;

  export type Health =
    | {
        ok: false;
        stage: "process" | "vmm" | "guest";
      }
    | {
        ok: true;
      };
}
