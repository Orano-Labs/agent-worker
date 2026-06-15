import { exec, spawn } from "node:child_process";
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface as createReadLineInterface } from "node:readline";

import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";
import type { Network } from "./network";

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

  async mount(dist: string) {}

  async create(path: string, root: string, net: Network.Slot) {
    const trim = (text: string): string => {
      const lines = text.split("\n").slice(1, -1);
      const padding = lines.reduce((minPadding, line) => {
        if (line.trim() === "") return minPadding;

        const match = line.match(/^(\s*)/);
        const currentPadding = match ? match[0].length : 0;

        return Math.min(minPadding, currentPadding);
      }, Number.MAX_SAFE_INTEGER);

      const actualPadding = padding === Number.MAX_SAFE_INTEGER ? 0 : padding;

      return lines.map((line) => line.slice(actualPadding)).join("\n");
    };

    const fileConfig = join(root, "ganesha.conf");
    const filePID = join(root, "ganesha.pid");
    const fileLog = join(root, "ganesha.log");

    const config = `
      NFS_CORE_PARAM
      {
        Protocols = 4;
        Bind_Addr = ${net.veth.host.ip};
      }

      NFSv4
      {
        # 为了防止服务器重启时导致之前的客户端文件锁丢失，NFSv4 协议规定重启后必须进入一段宽限期
        # NFS-Ganesha 默认的宽限期为 90 秒；再次期间所有写入都会被阻塞
        # 这里不需要它
        Graceless = true;
      }

      EXPORT
      {
        Export_Id = 1;
        Path = ${path};
        Pseudo = /workspace;
        Access_Type = RW;
        Squash = No_Root_Squash;

        FSAL {
          Name = VFS;
        }
      }
    `;

    await writeFile(fileConfig, trim(config));

    const args = ["ganesha.nfsd", "-F", "-L", fileLog, "-p", filePID, "-f", fileConfig];
    const ps = spawn("sudo", args, { stdio: ["inherit", "pipe", "pipe"] });

    await new Promise<void>((resolve, reject) => {
      ps.on("spawn", resolve);
      ps.on("error", reject);
    });

    ps.on("close", () => {
      this.#logger.debug("Closed ........");
    });

    return ps;
  }
}

export namespace FS {
  export type CreateOptions = {};
}
