import { createConnection } from "node:net";

import { Container } from "@/helpers/container";
import { FS } from "@/internal/fs";
import { Logger } from "@/internal/logger";
import { VM } from "@/internal/vm";
import { VMNet } from "@/internal/vm-net";

export class Orchestrator {
  #logger: Logger;
  #net: VMNet;
  #fs: FS;
  #vm: VM;

  constructor() {
    this.#logger = Container.inject(Logger).prefix("Orchestrator");
    this.#net = Container.inject(VMNet);
    this.#fs = Container.inject(FS);
    this.#vm = Container.inject(VM);
  }

  async run(options: Orchestrator.Options): Promise<Orchestrator.Task> {
    const id = options.instanceId;
    const logger = this.#logger.prefix(`TASK(${id})`);

    let net: VMNet.Namespace;
    let vm: VM.Instance;
    let fs: FS.Instance;

    try {
      net = await this.#net.random();
      vm = await this.#vm.create({
        id,
        net,
        ...options.config,
      });
      fs = await this.#fs.create({
        id,
        projectId: options.config.projectId,
        password: vm.fs.password,
      });

      await vm.fc.createSyncAction({ action_type: "InstanceStart" });
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
      if (vm && vm.process.exitCode !== null) {
        try {
          vm.process.kill("SIGKILL");
        } catch (err) {
          logger.warn(`Exception occurred while killing Runner child process (PID: ${vm.process.pid})`, { err });
        }
      }

      throw error;
    }

    const closed = (async () => {
      const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        vm.process.once("close", (code, signal) => {
          resolve({ code, signal });
        });
        vm.process.once("error", () => {
          resolve({ code: null, signal: null });
        });
      });

      if (net) {
        await this.#net.release(net).catch((err) => {
          logger.warn("Failed to release network namespace", { err });
        });
      }

      if (fs) {
        await fs.release().catch((err) => {
          logger.warn("Failed to release web dav server exposed", { err });
        });
      }

      return status;
    })();

    const ready = Promise.race([
      (async () => {
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
      })(),
      closed.then(() => {
        throw new Error("xxx");
      }),
    ]);

    // ready 失败时强制回收子进程及网络资源，避免残留僵尸 VM。
    ready.catch(async (error) => {
      logger.errorFrom(error, "Instance failed to become ready, forcibly reclaiming resources");

      if (vm.process.exitCode === null) {
        try {
          vm.process.kill("SIGKILL");
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
      runner: vm,
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
    readonly instanceId: string;
    readonly config: TaskConfig;
  };

  export type Task = {
    readonly net: VMNet.Namespace;
    readonly runner: VM.Instance;
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
