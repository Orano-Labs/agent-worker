import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface as createReadLineInterface } from "node:readline";
import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { $, type ProcessPromise } from "zx";

export class Ganesha extends Container.ServiceConstructable {
  #logger: Logger;
  #environment: Environment;

  #process?: ProcessPromise;

  #exports: Map<number, Ganesha.Export>;
  #nextExportId: number;

  #disposed: boolean;

  get #root() {
    return join(this.#environment.root, "ganesha");
  }

  get #config() {
    return join(this.#root, "ganesha.conf");
  }

  get #pid() {
    return join(this.#root, "ganesha.pid");
  }

  constructor(...deps: [Environment, Logger]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("Ganesha");
    this.#exports = new Map();
    this.#nextExportId = 1;
    this.#disposed = false;
  }

  #generateExportId() {
    return this.#nextExportId++;
  }

  #buildArgs() {
    const args: string[] = [];

    args.push("-f", this.#config);
    args.push("-p", this.#pid);

    args.push("-N", "NIV_INFO");
    args.push("-F");

    args.push("-x");

    return args;
  }

  #renderExport(entry: Ganesha.Export) {
    return Ganesha.EXPORT_TEMPLATE.replaceAll("<id>", String(entry.id))
      .replaceAll("<path>", entry.path)
      .replaceAll("<pseudo>", entry.pseudo)
      .replaceAll("<clients>", entry.clients.join(", "));
  }

  async #reload() {
    const process = this.#process;

    if (!process) {
      throw new Error("Ganesha.nfsd is not running, unable to reload configuration.");
    }

    this.#logger.info("Reloading ganesha.nfsd configuration (SIGHUP)...");

    await process.kill("SIGHUP");
  }

  async export(path: string, clients: string[]) {
    const entry: Ganesha.Export = {
      id: this.#generateExportId(),
      path,
      pseudo: `/${randomBytes(32).toString("base64url")}`,
      clients,
    };

    this.#exports.set(entry.id, entry);

    const exports = [...this.#exports.values()].sort((a, b) => a.id - b.id);

    try {
      await this.#render(exports);
      await this.#reload();
    } catch (error) {
      this.#logger.error("Failed to reload ganesha configuration after export", { error, path, clients });
      this.#exports.delete(entry.id);

      throw error;
    }

    this.#logger.info("Export added", { id: entry.id, path, clients });

    return entry;
  }

  async unexport(id: number) {
    const entry = this.#exports.get(id);

    if (!entry) {
      return;
    }

    this.#exports.delete(id);

    const exports = [...this.#exports.values()].sort((a, b) => a.id - b.id);

    try {
      await this.#render(exports);
      await this.#reload();
    } catch (error) {
      this.#logger.error("Failed to reload ganesha configuration after unexport", { error, id, path: entry.path });
      this.#exports.set(id, entry);

      throw error;
    }

    this.#logger.info("Export removed", { id, path: entry.path });

    return;
  }

  async #render(exports: Ganesha.Export[]) {
    const rendered = exports.map((entry) => this.#renderExport(entry));
    const content = `${[Ganesha.CONFIG_TEMPLATE.replaceAll("<recovery-root>", join(this.#root, "recovery")), ...rendered].join("\n\n")}\n`;

    const lines = content.replace(/^\n|\s+$/g, "").split("\n");
    const indents = lines.filter((line) => line.trim().length > 0).map((line) => line.length - line.trimStart().length);
    const indent = indents.length > 0 ? Math.min(...indents) : 0;

    const config = lines
      .map((line) => line.slice(indent))
      .join("\n")
      .replaceAll("\n\n\n", "\n");

    await writeFile(this.#config, config, "utf-8");
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

  async #reapStaleProcess(signal: AbortSignal) {
    const pid = await readFile(this.#pid, "utf-8")
      .then((raw) => {
        const pid = Number.parseInt(raw.trim(), 10);

        if (!Number.isInteger(pid) || pid <= 0) {
          return null;
        }

        return pid;
      })
      .catch(() => {
        return null;
      });

    if (pid === null) {
      return;
    }

    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
    }

    try {
      const comm = await readFile(`/proc/${pid}/comm`, "utf-8");

      if (comm.trim() !== "ganesha.nfsd") {
        return this.#logger.info("Stale pid does not point to ganesha.nfsd, ignoring", { pid });
      }
    } catch {
      return;
    }

    this.#logger.info("Found stale ganesha.nfsd process, sending SIGTERM", { pid });

    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }

      throw error;
    }

    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      signal.throwIfAborted();

      try {
        process.kill(pid, 0);
      } catch {
        this.#logger.info("Stale ganesha.nfsd process exited after SIGTERM", { pid });

        return;
      }

      await this.#sleep(100, signal);
    }

    this.#logger.warn("Stale ganesha.nfsd did not exit within 5s, sending SIGKILL", { pid });

    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }

  async #spawn(signal?: AbortSignal) {
    const shell = $({ halt: true, signal, detached: true });
    const args = this.#buildArgs();
    const process = shell`ganesha.nfsd ${args}`.stdio("ignore").nothrow();

    process.run().then((result) => {
      this.#logger.info("Ganesha.nfsd exit", { code: result.exitCode, sig: result.signal });
    });

    const stderrLogger = this.#logger.namespace("STDERR");
    const stdoutLogger = this.#logger.namespace("STDOUT");

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

    while (true) {
      signal?.throwIfAborted();

      await this.#sleep(500);

      if (process.stage === "rejected" || process.stage === "fulfilled") {
        throw new Error(`Ganesha.nfsd exited before becoming ready.`);
      }

      if (process.stage === "running") {
        this.#process = process;

        return;
      }
    }
  }

  async #startUntilReady(signal: AbortSignal) {
    let attempt = 1;

    while (true) {
      this.#logger.info(`Starting ganesha.nfsd (attempt ${attempt}/${3})...`);

      try {
        return await this.#spawn(signal);
      } catch (error) {
        if (attempt >= 3) {
          throw new Error(`Ganesha.nfsd failed to start after 3 attempts.`, { cause: error });
        }

        attempt++;
      }
    }
  }

  async #supervise() {
    while (!this.#disposed) {
      const process = this.#process;

      if (process) {
        await process.nothrow();
      }

      if (this.#disposed) {
        return;
      }

      this.#logger.warn("Ganesha.nfsd exited unexpectedly, restarting...");

      try {
        await this.#spawn(new AbortController().signal).then(() => {
          this.#logger.info("Ganesha.nfsd restarted successfully");
        });
      } catch (error) {
        this.#logger.error("Failed to restart ganesha.nfsd", { error });

        if (!this.#disposed) {
          await this.#sleep(1000);
        }
      }
    }
  }

  protected override async initialize(signal: AbortSignal) {
    signal.throwIfAborted();

    await this.#reapStaleProcess(signal);

    await mkdir(this.#root, { recursive: true });
    await this.#render([]);

    await this.#startUntilReady(signal);

    this.#supervise();
  }

  protected override async dispose(_reason?: unknown) {
    this.#disposed = true;

    const process = this.#process;

    if (!process) {
      return;
    }

    this.#process = undefined;
    this.#logger.info("Stopping ganesha.nfsd (SIGTERM)...");

    await process.kill("SIGTERM").catch(() => {});
    await process;
  }
}

export namespace Ganesha {
  export type Export = {
    readonly id: number;
    readonly path: string;
    readonly pseudo: string;
    readonly clients: readonly string[];
  };

  export const CONFIG_TEMPLATE = `
    nfs_core_param {
      # bind_addr: 0.0.0.0 for a single host-netns instance;
      # 10.123.0.1 for a per-VM-netns instance (that address only exists inside VM netns).
      bind_addr = 0.0.0.0;
      nfs_port = 26088;

      # NFSv4 only; no rpcbind/mountd/NLM/RQUOTA needed.
      protocols = 4;
      enable_udp = false;
      enable_nlm = false;
      enable_rquota = false;
      enable_nfsacl = false;

      # Mount via NFSv4 pseudo path.
      mount_path_pseudo = true;

      clustered = false;
      # Conservative limits so one VM cannot exhaust the server.
      rpc_max_connections = 1024;
      rpc_idle_timeout_s = 120;
      short_file_handle = false;
      # Tolerate EPERM on PR_SET_IO_FLUSHER (non-root / restricted containers).
      allow_set_io_flusher_fail = true;
    }

    nfsv4 {
      # No delegations: otherwise clients cache writes and may lose them if the VM dies.
      delegations = false;
      # Skip 4.0 (weak session/reclaim); offer 4.1 / 4.2 only.
      minor_versions = 1, 2;
      # Short lease/grace so state is cleaned up quickly after a VM is destroyed.
      lease_lifetime = 30;
      grace_period = 30;
      # Local recovery (no Ceph/cluster backend), under our own root.
      recoverybackend = fs;
      recoveryroot = <recovery-root>;
    }

    export_defaults {
      # Deny by default; each export must authorize explicitly.
      access_type = none;
      protocols = 4;
      transports = tcp;
      sectype = sys;

      squash = root_squash;

      anonymous_uid = 1000;
      anonymous_gid = 1000;

      # Never allow privileged client ports.
      privilegedport = false;
      manage_gids = false;

      # Server flushes on COMMIT instead of deferring asynchronously.
      nfs_commit = true;
      delegations = none;

      # Expire attributes immediately so destroyed VMs stop showing stale state.
      attr_expiration_time = 0;
    }

    # Small object cache to shrink the window of data living only in Ganesha's cache.
    mdcache {
      entries_hwmark = 10000;
      dir_chunk = 32;
    }

    log {
      default_log_level = info;

      # Log to the terminal. Requires destination plus enable = default, otherwise
      # Ganesha falls back to SYSLOG. The Supervisor captures the child's stdout/stderr.
      facility {
        name = stdout;
        destination = stdout;
        enable = default;
      }

      # Minimal prefix: keep only component and level, drop date/time/user/host/etc.
      format {
        date_format = none;
        time_format = none;
        epoch = false;
        clientip = false;
        hostname = false;
        progname = false;
        pid = false;
        thread_name = false;
        function_name = false;
        file_name = false;
        line_num = false;
        component = true;
        level = true;
      }
    }
  `;

  export const EXPORT_TEMPLATE = `
    export {
      export_id = <id>;
      path = <path>;
      pseudo = <pseudo>;
      access_type = none;
      protocols = 4;
      transports = tcp;
      squash = root_squash;
      nfs_commit = true;
      attr_expiration_time = 0;

      fsal {
        name = vfs;
      }

      client {
        clients = <clients>;
        access_type = rw;
        squash = no_root_squash;
        protocols = 4;
        transports = tcp;
      }
    }
  `;
}
