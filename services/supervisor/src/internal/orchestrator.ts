import { createConnection } from "node:net";

import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";
import { VM } from "@/internal/vm";
import { VMNet } from "@/internal/vm-net";
import { VMWorkspace } from "@/internal/vm-workspace";

export class Orchestrator {
  #logger: Logger;
  #net: VMNet;
  #fs: VMWorkspace;
  #vm: VM;

  constructor() {
    this.#logger = Container.inject(Logger).prefix("Orchestrator");
    this.#net = Container.inject(VMNet);
    this.#fs = Container.inject(VMWorkspace);
    this.#vm = Container.inject(VM);
  }

  async run(options: Orchestrator.Options): Promise<Orchestrator.Task> {
    const id = options.instanceId;
    const logger = this.#logger.prefix(`TASK(${id})`);

    let net: VMNet.Namespace | undefined;
    let vm: VM.Instance | undefined;

    const cleanups: Array<() => Promise<void>> = [];

    try {
      const namespace = await this.#net.random();

      cleanups.push(async () => {
        if (net) {
          await this.#net.release(net);
        }
      });

      const password = await this.#fs.expose({
        id,
        projectId: options.config.projectId,
        ip: namespace.veth.guest.ip,
      });

      cleanups.push(async () => {
        await this.#fs.unexpose(id);
      });

      const instance = await this.#vm.create({
        id,
        net: namespace,
        password,
        ...options.config,
      });

      cleanups.push(async () => {
        if (instance.process.exitCode === null) {
          instance.process.kill("SIGKILL");
        }
      });

      await instance.fc.createSyncAction({ action_type: "InstanceStart" });

      net = namespace;
      vm = instance;
    } catch (error) {
      logger.errorFrom(error, "Failed to initialize task instances, starting forced resource cleanup...");

      for (const cleanup of [...cleanups].reverse()) {
        try {
          await cleanup();
        } catch (err) {
          logger.warn("Cleanup step failed", { err });
        }
      }

      throw error;
    }

    let exited = false;

    const waitClosed = (async () => {
      const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        vm!.process.once("close", (code, signal) => {
          resolve({ code, signal });
        });
        vm!.process.once("error", () => {
          resolve({ code: null, signal: null });
        });
      });

      exited = true;

      for (const cleanup of [...cleanups].reverse()) {
        try {
          await cleanup();
        } catch (err) {
          logger.warn("Cleanup step failed", { err });
        }
      }

      return status;
    })();

    const waitPort = (async () => {
      let attempt = 0;

      while (attempt <= 3) {
        if (exited) {
          throw new Error("VM closed before becoming ready");
        }

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
            host: net.veth.guest.ip,
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

    const ready = Promise.race([
      waitPort,
      waitClosed.then(() => {
        throw new Error("VM closed before becoming ready");
      }),
    ]);

    ready.catch(async (error) => {
      logger.errorFrom(error, "Instance failed to become ready, forcibly reclaiming resources");

      if (vm!.process.exitCode === null) {
        try {
          vm!.process.kill("SIGKILL");
        } catch (err) {
          logger.warn("Failed to kill runner child process during reclaim", { err });
        }
      }
    });

    return {
      net,
      runner: vm,
      config: options.config,
      closed: waitClosed,
      ready,
    };
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
