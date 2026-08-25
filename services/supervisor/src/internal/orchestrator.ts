import { createConnection } from "node:net";
import { customAlphabet } from "nanoid";
import { alphanumeric } from "nanoid-dictionary";

import { Container } from "@/helpers/container";
import { FS } from "@/internal/fs";
import { Logger } from "@/internal/logger";
import { Network } from "@/internal/network";
import { Runner } from "@/internal/runner";

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
  }

  async run(options: Orchestrator.Options): Promise<Orchestrator.Task> {
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

    const ready = (async () => {
      let attempt = 0;

      while (attempt <= 3) {
        try {
          attempt += 1;

          await new Promise<void>((resolve, reject) => {
            const conn = createConnection({ host: net.veth.guest.ip, port: 8000 });

            conn.on("connect", () => {
              conn.destroy();
              resolve();
            });

            conn.on("error", (error) => {
              conn.destroy();
              reject(error);
            });
          });

          return;
        } catch (error) {
          logger.warn("Instance port 8000 is not ready yet, retrying...", {
            attempt,
            host: net.veth.guest.ip,
            error,
          });

          if (attempt <= 3) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 3000);
            });
          }
        }
      }

      throw new Error(`Instance did not become ready on port 8000 after ${attempt} attempts.`);
    })();

    // ready 失败时强制回收子进程及网络资源，避免残留僵尸 VM。
    void ready.catch((error) => {
      logger.errorFrom(error, "Instance failed to become ready, forcibly reclaiming resources");

      if (runner.process.exitCode === null) {
        try {
          runner.process.kill("SIGKILL");
        } catch (err) {
          logger.warn("Failed to kill runner child process during reclaim", { err });
        }
      }

      return this.#net.release(net).catch((err) => {
        logger.warn("Failed to release network namespace during reclaim", { err });
      });
    });

    const task: Orchestrator.Task = {
      net,
      runner,
      fs,
      config: options.config,
      closed,
      ready,
    };

    return task;
  }
}

export namespace Orchestrator {
  export type Options = {
    instanceId: string;
    config: TaskConfig;
  };

  export type Task = {
    readonly net: Network.Namespace;
    readonly runner: Runner.Instance;
    readonly fs: FS.Instance;
    readonly config: TaskConfig;
    readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    readonly ready: Promise<void>;
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
