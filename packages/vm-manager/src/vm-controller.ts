import { mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { customAlphabet } from "nanoid";
import { alphanumeric } from "nanoid-dictionary";
import { VM } from "@/vm";
import { VMEnvironment } from "@/vm-environment";
import { VMNet } from "@/vm-net";

export class VMController extends VMEnvironment {
  #db: DatabaseSync;

  #gid: number;
  #uid: number;

  #instances: Map<string, VM>;

  constructor(options: VMController.Options) {
    super(options.root);

    this.#db = new DatabaseSync(":memory:");

    this.#instances = new Map();

    this.#gid = options.gid ?? userInfo().gid;
    this.#uid = options.uid ?? userInfo().uid;
  }

  get db() {
    return this.#db;
  }

  get gid() {
    return this.#gid;
  }

  get uid() {
    return this.#uid;
  }

  #transaction<T>(callback: () => T) {
    try {
      this.#db.exec("BEGIN EXCLUSIVE TRANSACTION");
      const result = callback();
      this.#db.exec("COMMIT");

      return result;
    } catch (error) {
      if (this.#db.isTransaction) {
        this.#db.exec("ROLLBACK");
      }

      throw error;
    }
  }

  create(options: VMController.CreateOptions = {}) {
    return this.#transaction(() => {
      const id = customAlphabet(alphanumeric, 12)();
      const root = join(this.chroot, "firecracker", id, "root");
      const rows = this.#db.prepare(`SELECT net_slot FROM vm_configs WHERE state != 'archived'`).all();
      const allocated = rows.map((row) => row.net_slot as number);

      let slot = -1;

      for (let s = VMNet.NS_MIN_SLOT; s <= VMNet.NS_MAX_SLOT; s++) {
        if (!allocated.includes(s)) {
          slot = s;
        }

        if (slot > -1) {
          break;
        }
      }

      if (slot === -1) {
        throw new Error(`No available network slots (${VMNet.NS_MIN_SLOT}-${VMNet.NS_MAX_SLOT})`);
      }

      mkdirSync(root, { recursive: true });

      this.#db
        .prepare(
          `INSERT INTO vm_configs (id, cpus, memory, disk, net_slot, net_bandwidth, image) VALUES (@id, @cpus, @memory, @disk, @net_slot, @net_bandwidth, @image)`,
        )
        .run({
          id,
          cpus: options?.cpus ?? 1,
          memory: options?.memory ?? 256,
          disk: options?.disk ?? 1024,
          net_slot: slot,
          net_bandwidth: options?.bandwidth ?? null,
          image: options?.image ?? null,
        });

      return this.get(id);
    });
  }

  list(options: VMController.ListOptions = {}) {
    const { state, image, limit, offset } = options;

    let sql = `SELECT id FROM vm_configs`;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (state) {
      conditions.push(`state = ?`);
      params.push(state);
    }

    if (image) {
      conditions.push(`image = ?`);
      params.push(image);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    sql += ` ORDER BY created_at DESC`;

    if (limit !== undefined && limit > 0) {
      sql += ` LIMIT ?`;
      params.push(limit);

      if (offset !== undefined && offset >= 0) {
        sql += ` OFFSET ?`;
        params.push(offset);
      }
    }

    return this.#db
      .prepare(sql)
      .all(...params)
      .map((row) => this.get(row.id as string));
  }

  get(id: string) {
    let vm = this.#instances.get(id);

    if (!vm) {
      const row = this.#db.prepare("SELECT * FROM vm_configs WHERE id = ?").get(id);

      if (!row) {
        throw new Error(`VM with id "${id}" not found in database.`);
      }

      vm = new VM(this, id);
    }

    this.#instances.set(id, vm);

    return vm;
  }

  async init() {
    await super.init();

    this.#db = new DatabaseSync(join(this.root, "vms/data.db"));

    this.#db.exec("CREATE TABLE IF NOT EXISTS vm_configs (id TEXT PRIMARY KEY);");
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA busy_timeout = 5000;");

    const columns = [
      {
        name: "state",
        type: "TEXT NOT NULL CHECK(state IN ('active', 'archived')) DEFAULT 'active'",
      },
      {
        name: "cpus",
        type: "INTEGER NOT NULL DEFAULT 1 CHECK(cpus > 0)",
      },
      {
        name: "memory",
        type: "INTEGER NOT NULL DEFAULT 128 CHECK(memory >= 128)",
      },
      {
        name: "disk",
        type: "INTEGER NOT NULL DEFAULT 1024 CHECK(disk >= 1024)",
      },
      {
        name: "net_slot",
        type: `INTEGER NOT NULL CHECK(net_slot >= ${VMNet.NS_MIN_SLOT} AND net_slot <= ${VMNet.NS_MAX_SLOT})`,
      },
      {
        name: "net_bandwidth",
        type: `INTEGER CHECK(net_bandwidth >= 1 AND net_bandwidth <= 10000)`,
      },
      {
        name: "image",
        type: `TEXT`,
      },
      {
        name: "created_at",
        type: "DATETIME DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))",
      },
      {
        name: "updated_at",
        type: "DATETIME DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))",
      },
    ];

    const existingColumns = this.#db.prepare("PRAGMA table_info(vm_configs)").all() as { name: string }[];
    const existingNames = existingColumns.map((c) => c.name);

    for (const col of columns) {
      if (!existingNames.includes(col.name)) {
        this.#db.exec(`ALTER TABLE vm_configs ADD COLUMN ${col.name} ${col.type};`);
      }
    }

    this.#db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_net_slot_unique_active ON vm_configs(net_slot) WHERE state != 'archived';`);
  }
}

export namespace VMController {
  export type Options = {
    root: string;
    uid?: number;
    gid?: number;
  };

  export type CreateOptions = {
    disk?: number;
    memory?: number;
    cpus?: number;
    image?: string;
    bandwidth?: number;
  };

  export type ListOptions = {
    state?: "created" | "running" | "stopped" | "archived";
    image?: string;
    limit?: number;
    offset?: number;
  };
}
