import { type ChildProcessByStdio, exec, execSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface as createReadLineInterface } from "node:readline";
import type { Readable } from "node:stream";
import { asError } from "catch-unknown";
import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";
import type { Network } from "./network";
import type { Orchestrator } from "./orchestrator";

export class FS {
  #logger: Logger;
  #cli: CommandLine;
  #variables: Variables;
  #env: Environment;

  constructor() {
    this.#logger = Container.inject(Logger).scope("FS");
    this.#cli = Container.inject(CommandLine);
    this.#variables = Container.inject(Variables);
    this.#env = Container.inject(Environment);
  }

  // async create(options: FS.Options) {
  //   const trim = (text: string) => {
  //     const lines = text.split("\n").slice(1, -1);
  //     const padding = lines.reduce((minPadding, line) => {
  //       if (line.trim() === "") return minPadding;

  //       const match = line.match(/^(\s*)/);
  //       const currentPadding = match ? match[0].length : 0;

  //       return Math.min(minPadding, currentPadding);
  //     }, Number.MAX_SAFE_INTEGER);

  //     const actualPadding = padding === Number.MAX_SAFE_INTEGER ? 0 : padding;

  //     return lines.map((line) => line.slice(actualPadding)).join("\n");
  //   };

  //   await new Promise<void>((resolve, reject) => {
  //     exec(`rpcinfo -t ${options.net.veth.host.ip} nfs 4`, (err, stdout) => {
  //       if (err) {
  //         resolve()
  //       } else {
  //         reject("Port using .....")
  //       }
  //     })
  //   })

  //   const fileConfig = join(options.root, "ganesha.conf");
  //   const filePID = join(options.root, "ganesha.pid");
  //   const fileLog = join(options.root, "ganesha.log");

  //   const logger = this.#logger.scope(options.id);

  //   const workspace = join(FS.ROOT, "projects", options.config.projectId);

  //   const config = `
  //     NFS_CORE_PARAM
  //     {
  //       Protocols = 4;
  //       Bind_Addr = ${options.net.veth.host.ip};
  //       Dbus_Name_Prefix = "${options.id}";
  //       Enable_UDP = false;
  //       allow_set_io_flusher_fail = true;
  //     }

  //     NFSv4
  //     {
  //       # 为了防止服务器重启时导致之前的客户端文件锁丢失，NFSv4 协议规定重启后必须进入一段宽限期
  //       # NFS-Ganesha 默认的宽限期为 90 秒；再次期间所有写入都会被阻塞
  //       # 这里不需要它
  //       Graceless = true;
  //     }

  //     EXPORT
  //     {
  //       Export_Id = 1;
  //       Path = ${workspace};
  //       Pseudo = /workspace;
  //       Access_Type = RW;
  //       Squash = No_Root_Squash;

  //       FSAL {
  //         Name = VFS;
  //       }
  //     }
  //   `;

  //   await writeFile(fileConfig, trim(config));

  //   try {
  //     await stat(workspace)
  //   } catch {
  //     await mkdir(workspace, { recursive: true })
  //   }

  //   const args = ["ganesha.nfsd", "-L", fileLog, "-p", filePID, "-f", fileConfig, "-x"];

  //   execSync(`${args.join(" ")}`);

  //   const timeoutSignal = AbortSignal.timeout(1000 * 2);

  //   try {
  //     await new Promise<void>((resolve, reject) => {
  //       let error: unknown;

  //       const attempt = () => {
  //         if (timeoutSignal.aborted) {
  //           console.log(filePID)
  //           console.log(fileLog)
  //           return reject(new Error(`NFS-Ganesha server (NFSv4) on ${options.net.veth.host.ip} not ready.${error ? ` Last error: ${asError(error).message}` : ""}`));
  //         }

  //         exec(`rpcinfo -t ${options.net.veth.host.ip} nfs 4`, (err, stdout) => {
  //           if (err) {
  //             setTimeout(attempt, 50);

  //             error = err;
  //           } else {
  //             resolve()
  //           }
  //         })
  //       };

  //       attempt();
  //     })
  //   } catch (error) {
  //     throw error;
  //   }

  //   const processId = await readFile(filePID, "utf-8").then((content) => {
  //     Number.parseInt(content, 10)
  //   });

  //   const instance: FS.Instance = {
  //     kill: () => {
  //       execSync(`kill -9 ${processId}`)
  //     }
  //   }

  //   logger.info(`NFS instance creation completed (ip: ${options.net.veth.host.ip})`, {
  //     processId
  //   });

  //   return instance;
  // }

  async create(options: FS.Options) {
    const logger = this.#logger.scope(options.id);

    const workspace = join("projects", options.config.projectId);

    const stdout = createWriteStream(join(options.root, "fs.stdout"));
    const stderr = createWriteStream(join(options.root, "fs.stderr"));

    const host = `${options.net.veth.host.ip}:2049`;
    const args = ["juicefs", "webdav", "redis://192.168.5.2:6379/2", host];

    args.push("--log", join(options.root, "fs.log"));
    args.push("--access-log", join(options.root, "fs-access.log"));
    // args.push("--cache-dir", join(options.root, "fs-cache"));
    // args.push("--cache-size", `${1024 * 1024}`);
    // args.push("--buffer-size", "512");
    // args.push("--max-uploads", "50");
    // args.push("--writeback");
    args.push("--check-storage");
    args.push("--subdir", workspace);

    const ps = spawn("sudo", args, {
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        ...{
          WEBDAV_USER: options.username,
          WEBDAV_PASSWORD: options.password,
        },
      },
    });

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
      ps.on("spawn", resolve);
      ps.on("error", reject);
    });

    const instance: FS.Instance = {
      process: ps,
    };

    logger.info(`JuiceFS instance creation completed (ip: ${options.net.veth.host.ip})`);

    return instance;
  }

  async init() {
    await new Promise<void>((resolve, reject) => {
      exec(`juicefs --version`, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        }

        this.#logger.info(`JuiceFS version: ${stdout.replace("juicefs version", "").trim()}`);

        resolve();
      });
    });
  }
}

export namespace FS {
  export type Options = {
    readonly id: string;
    readonly net: Network.Namespace;
    readonly config: Orchestrator.TaskConfig;
    readonly root: string;
    readonly username: string;
    readonly password: string;
  };

  export type Instance = {
    readonly process: ChildProcessByStdio<null, Readable, Readable>;
  };

  export const ROOT = "/mnt/juicefs";
}
