import { customAlphabet } from "nanoid";
import { alphanumeric } from "nanoid-dictionary";

import { Container } from "@/helpers/container";
import { FS } from "@/internal/fs";
import { Logger } from "@/internal/logger";
import { Network } from "@/internal/network";
import { Runner } from "@/internal/runner";

// sudo sysctl -w vm.nr_hugepages=2048

export class Orchestrator {
  #logger: Logger;
  #net: Network;
  #fs: FS;
  #runner: Runner;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Orchestrator");
    this.#net = Container.inject(Network);
    this.#fs = Container.inject(FS);
    this.#runner = Container.inject(Runner);

    this.#tasks = new Map();
  }

  #tasks: Map<string, Orchestrator.Task>;

  async kill(taskId: string, signal: NodeJS.Signals = "SIGKILL") {
    this.#tasks.get(taskId)?.runner.process.kill(signal);

    return this.taskClosed(taskId);
  }

  async taskClosed(taskId: string) {
    await this.#tasks.get(taskId)?.closed;
  }

  async create(options: Orchestrator.Options) {
    const id = customAlphabet(alphanumeric, 12)();

    const logger = this.#logger.scope(`TASK(${id})`);

    let net: Network.Namespace;
    let runner: Runner.Instance;
    let fs: FS.Instance;

    try {
      net = await this.#net.random();
      runner = await this.#runner.create({
        id,
        net,
        config: options.config,
      });
      fs = await this.#fs.create({
        id,
        config: options.config,
        password: runner.fs.password,
      });

      await runner.fc.createSyncAction({ action_type: "InstanceStart" });
    } catch (error) {
      logger.errorFrom(error, "Failed to initialize task instances, starting forced resource cleanup...");

      // @ts-expect-error
      if (net) {
        await this.#net.release(net).catch((err) => {
          logger.warn("Failed to release network namespace", { err });
        });
      }

      // @ts-expect-error
      if (fs) {
        await fs.release().catch((err) => {
          logger.warn("Failed to release web dav server exposed", { err });
        });
      }

      // @ts-expect-error
      if (runner && runner.process.exitCode !== null) {
        try {
          runner.process.kill("SIGKILL");
        } catch (err) {
          logger.warn(`Exception occurred while killing Runner child process (PID: ${runner.process.pid})`, { err });
        }
      }

      throw error;
    }

    const closed = (async () => {
      const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        runner.process.once("close", (code, signal) => {
          resolve({ code, signal });
        });
      });

      if (fs) {
        await fs.release().catch((err) => {
          logger.warn("Failed to release web dav server exposed", { err });
        });
      }

      return status;
    })();

    const task: Orchestrator.Task = {
      net,
      runner,
      fs,
      config: options.config,
      closed,
    };

    this.#tasks.set(id, task);

    return id;
  }
}

export namespace Orchestrator {
  export type Options = {
    config: TaskConfig;
  };

  export type Task = {
    /**
     * NetNamespace
     */
    readonly net: Network.Namespace;
    /**
     * 用于运行该任务的虚拟机实例
     */
    readonly runner: Runner.Instance;
    /**
     * 该任务的文件系统的 NFS 服务
     */
    readonly fs: FS.Instance;
    /**
     * 任务运行配置
     */
    readonly config: TaskConfig;
    /**
     * 一个 Promise 当任务结束时 resolve
     */
    readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  };

  export type TaskConfig = {
    /**
     * 项目 ID
     */
    readonly projectId: string;
    /**
     * 任务运行时环境变量
     */
    readonly env: Record<string, string>;
    /**
     * 机器规格
     */
    readonly machineTier: "minimal" | "standard" | "performance";
    /**
     * 元数据
     */
    readonly metadata: Record<string, unknown>;
  };
}
