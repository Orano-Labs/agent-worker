import { createConnection } from "node:net";
import { join } from "node:path";
import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { Client, ProjectPB, SupervisorPortalPB } from "@aw/vm-director/sdk";
import type { Director } from "@/internal/director";
import type { Ganesha } from "@/internal/ganesha";
import type { KVStorage } from "@/internal/kv-storage";
import type { VMFactory } from "@/internal/vm-factory";

export class Controller extends Container.ServiceConstructable {
  #logger: Logger;
  #director: Director;
  #ganesha: Ganesha;
  #kv: KVStorage;
  #manager: VMFactory;
  #fsRoot: string;

  #portal?: ReturnType<Client["createSupervisorPortalService"]>;
  #processings: Map<string, Promise<Controller.RunningInstance>>;
  #watching?: {
    controller: AbortController;
    stream: Promise<void>;
  };

  constructor(...deps: [Environment, Logger, KVStorage, Director, VMFactory, Ganesha]) {
    super();

    this.#fsRoot = deps[0].get("FS_ROOT", join(deps[0].root, "fs"));
    this.#logger = deps[1].namespace("Controller");
    this.#kv = deps[2];
    this.#director = deps[3];
    this.#manager = deps[4];
    this.#ganesha = deps[5];
    this.#processings = new Map();
  }

  get #portalMust() {
    if (!this.#portal) {
      throw new Error("Controller has not been initialized. Call init() first.");
    }

    return this.#portal;
  }

  processing(instanceId: string) {
    return this.#processings.get(instanceId);
  }

  protected override async initialize(signal: AbortSignal) {
    signal.throwIfAborted();

    this.#portal = this.#director.client.createSupervisorPortalService();

    await this.#releaseAllInstances();

    this.#logger.info("Controller initialized, starting supervisor portal watch stream");

    const ctrl = new AbortController();

    signal.addEventListener("abort", () => ctrl.abort(), { once: true });

    const stream = this.#watch(ctrl.signal);

    this.#watching = { controller: ctrl, stream };
  }

  protected override async dispose() {
    const watch = this.#watching;

    if (!watch) {
      return;
    }

    this.#watching = undefined;

    watch.controller.abort();

    await Promise.all([
      ...[...this.#processings.values()].map(async (run) => {
        return run
          .then((r) => {
            r.controller.abort();

            return r.process;
          })
          .catch(() => {});
      }),
      watch.stream,
    ]);
  }

  async #watch(signal: AbortSignal) {
    while (true) {
      signal.throwIfAborted();

      try {
        const stream = this.#portalMust.watch(
          Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceWatchRequestSchema, {
            processId: this.#director.processId,
          }),
          {
            signal,
          },
        );

        for await (const response of stream) {
          if (response.event.case !== "assignmentList") {
            continue;
          }

          const loads = response.event.value.list;
          const serverIds = new Set(loads.map((load) => load.instanceId));

          for (const load of loads) {
            if (!load.confirmed) {
              this.#logger.info("Acknowledging unconfirmed instance", { instanceId: load.instanceId });

              try {
                await this.#portalMust.acknowledge(
                  Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceAcknowledgeRequestSchema, {
                    instanceId: load.instanceId,
                    status: SupervisorPortalPB.AcknowledgeStatus.OK,
                  }),
                );
              } catch (error) {
                this.#logger.error(`Failed to acknowledge instance (${load.instanceId})`, { err: error });
              }
            } else {
              let projectResourceTier: Controller.Instance["projectResourceTier"];

              if (load.projectResourceTier === ProjectPB.ProjectResourceTier.STANDARD) {
                projectResourceTier = "standard";
              } else if (load.projectResourceTier === ProjectPB.ProjectResourceTier.PERFORMANCE) {
                projectResourceTier = "performance";
              } else {
                projectResourceTier = "minimal";
              }

              await this.#schedule({
                id: load.instanceId,
                projectId: load.projectId,
                projectResourceTier,
                createTimestamp: new Date(Number(load.timestamp.seconds) * 1000 + load.timestamp.nanos / 1_000_000),
              });
            }
          }

          for (const { key, value } of this.#kv.db.getRange({ start: Controller.INSTANCE_KEY_PREFIX })) {
            const instance = value as Controller.Instance;

            if (serverIds.has(instance.id)) {
              continue;
            }

            await this.#kv.db
              .remove(key)
              .then(() => {
                this.#logger.info("Removed instance not present in server sync", { instanceId: instance.id });
              })
              .catch((error) => {
                this.#logger.warn("Failed to remove instance not present in server sync", { instanceId: instance.id, error });
              });
          }

          for (const [key, value] of this.#processings.entries()) {
            if (serverIds.has(key)) {
              continue;
            }

            value
              .then((instance) => {
                instance.controller.abort();
              })
              .catch(() => {});
          }
        }

        this.#logger.warn("Watch stream closed, reconnecting", { delay: 2000 });
      } catch (error) {
        if (!signal.aborted) {
          this.#logger.error("Watch stream closed with error, reconnecting", { err: error });
        }
      }

      if (!signal.aborted) {
        await this.#sleep(2000, signal);
      }
    }
  }

  async #sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) {
        return resolve();
      }

      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
    });
  }

  async #schedule(instance: Controller.Instance) {
    const instanceId = instance.id;
    const key = `${Controller.INSTANCE_KEY_PREFIX}${instanceId}`;
    const logger = this.#logger.namespace(instance.id);

    if (this.#processings.has(instanceId) || this.#kv.db.get(key) !== undefined) {
      return;
    }

    await this.#kv.db.put(key, instance);

    logger.info("Scheduling instance", {
      projectId: instance.projectId,
      resourceTier: instance.projectResourceTier,
    });

    const processing = this.#run(instance, logger);

    processing
      .then(async (run) => {
        await run.process;

        logger.info("Instance run finished", {
          instanceId: instance.id,
          projectId: instance.projectId,
        });
      })
      .catch(async (error) => {
        logger.error("Failed to create task for instance.", { err: error });
      })
      .finally(async () => {
        this.#processings.delete(instance.id);

        // 创建任务失败时向 Portal 释放，而不是直接删除本地记录；
        // 本地 KV 记录会在后续 Watch 同步发现 Server 不再下发时由 diff 清理。
        try {
          await this.#release(instance.id).then(() => {
            logger.info("Instance released", { instanceId: instance.id });
          });
        } catch (error) {
          logger.error(`Failed to release instance (${instance.id})`, { err: error });
        }
      });

    this.#processings.set(instanceId, processing);
  }

  async #run(instance: Controller.Instance, logger: Logger) {
    return new Promise<Controller.RunningInstance>((resolve, reject) => {
      const vm = this.#manager.create({
        id: instance.id,
        machineTier: instance.projectResourceTier,
      });

      const controller = new AbortController();

      const running = vm.run(controller.signal, async (_, resources) => {
        const path = join(this.#fsRoot, "projects", instance.projectId);
        const exportEntry = await this.#ganesha.export(path, [resources.net.veth.guest.ip]);

        resources.process.finally(async () => {
          await this.#ganesha.unexport(exportEntry.id).catch(() => {});
        });

        await resources.firecracker.putMmds({
          latest: {
            "workspace-nfs-path": exportEntry.pseudo,
          },
        });

        resolve({
          id: instance.id,
          projectId: instance.projectId,
          projectResourceTier: instance.projectResourceTier,
          createTimestamp: instance.createTimestamp,
          controller,
          firecracker: resources.firecracker,
          root: resources.root,
          net: resources.net,
          process: resources.process,
          nfs: exportEntry,
          ready: (async () => {
            let attempt = 0;

            while (attempt <= 30) {
              if (resources.process.stage === "fulfilled" || resources.process.stage === "rejected") {
                throw new Error("VM closed before becoming ready");
              }

              const host = resources.net.veth.guest.ip;

              try {
                attempt += 1;

                return await new Promise<URL>((resolve, reject) => {
                  const conn = createConnection({ host, port: 8000 });

                  conn.on("connect", () => {
                    conn.destroy();
                    logger.info("Instance port 8000 is ready", { instanceId: instance.id, host });

                    resolve(new URL(`http://${host}:8000`));
                  });

                  conn.on("error", (error) => {
                    conn.destroy();
                    reject(error);
                  });
                });
              } catch (error) {
                this.#logger.warn("Instance port 8000 is not ready yet, retrying...", {
                  host,
                  err: error,
                });

                if (attempt <= 30) {
                  await this.#sleep(1000, controller.signal);
                }
              }
            }

            throw new Error(`Instance did not become ready on port 8000 after ${attempt} attempts.`);
          })(),
        });
      });

      running
        .then(() => {
          reject(new Error("VM exited before configuration completed."));
        })
        .catch((error) => {
          reject(new Error("VM failed during configuration", { cause: error }));
        });
    });
  }

  async #release(instanceId: string) {
    await this.#portalMust.release(
      Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceReleaseRequestSchema, {
        instanceId,
      }),
    );
  }

  async #releaseAllInstances() {
    for (const { key } of this.#kv.db.getRange({ start: Controller.INSTANCE_KEY_PREFIX })) {
      const instanceId = key.slice(Controller.INSTANCE_KEY_PREFIX.length);

      this.#logger.info("Releasing stale instance", { instanceId });

      try {
        await this.#release(instanceId);
      } catch (error) {
        this.#logger.warn("Failed to release stale instance", { instanceId, error });
      }
    }
  }
}

export namespace Controller {
  export const INSTANCE_KEY_PREFIX = "instance:";

  export type Instance = {
    id: string;
    projectId: string;
    projectResourceTier: "minimal" | "standard" | "performance";
    createTimestamp: Date;
  };

  export type RunningInstance = Readonly<
    VMFactory.VM.Resources &
      Instance & {
        controller: AbortController;
        ready: Promise<URL>;
        nfs: Ganesha.Export;
      }
  >;
}
