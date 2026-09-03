import { Client, ProjectPB, SupervisorPortalPB } from "@aw/vm-director/sdk";
import { Container } from "@/helpers/container";
import { Director } from "@/internal/director";
import { KVStorage } from "@/internal/kv-storage";
import { Logger } from "@/internal/logger";
import { Orchestrator } from "@/internal/orchestrator";

export class Controller {
  #logger: Logger;
  #kv: KVStorage;
  #director: Director;
  #orchestrator: Orchestrator;
  #portal?: ReturnType<Client["createSupervisorPortalService"]>;
  #processings: Map<string, Promise<Orchestrator.Task>>;

  constructor() {
    this.#logger = Container.inject(Logger).prefix("Controller");
    this.#kv = Container.inject(KVStorage);
    this.#director = Container.inject(Director);
    this.#orchestrator = Container.inject(Orchestrator);
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

  async init() {
    this.#portal = this.#director.client.createSupervisorPortalService();

    await this.#releaseAllRunningInstances();

    this.#logger.info("Controller initialized, starting supervisor portal watch stream");

    this.#watch().catch((error) => {
      this.#logger.errorFrom(error, "Watch loop terminated unexpectedly");
    });
  }

  async #watch() {
    while (true) {
      const stream = this.#portalMust.watch(Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceWatchRequestSchema, {}));

      try {
        for await (const response of stream) {
          if (response.event.case !== "load") {
            continue;
          }

          const loads = response.event.value.list;
          const serverIds = new Set(loads.map((load) => load.instanceId));

          for (const load of loads) {
            if (!load.confirmed) {
              await this.#acknowledge(load.instanceId);
            } else {
              await this.#schedule(load);
            }
          }

          for (const { key, value } of this.#kv.db.getRange({ start: Controller.INSTANCE_KEY_PREFIX })) {
            const instance = value as Controller.RunningInstance;

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
        }

        this.#logger.warn("Watch stream closed, reconnecting", { delay: 2000 });
      } catch (error) {
        this.#logger.errorFrom(error, "Watch stream terminated with error, reconnecting");
      }

      await this.#sleep(2000);
    }
  }

  async #schedule(load: SupervisorPortalPB.LoadValid) {
    const instanceId = load.instanceId;
    const key = this.#instanceStorageKey(instanceId);

    if (this.#processings.has(instanceId) || this.#kv.db.get(key) !== undefined) {
      return;
    }

    this.#logger.info("Scheduling instance", {
      instanceId,
      projectId: load.projectId,
      resourceTier: load.projectResourceTier,
    });

    const instance = this.#loadToRunningInstance(load);
    await this.#kv.db.put(key, instance);

    const processing = this.#orchestrator.run({
      instanceId,
      config: {
        projectId: load.projectId,
        machineTier: instance.projectResourceTier,
        env: {},
        metadata: {},
      },
    });

    this.#processings.set(instanceId, processing);

    void processing
      .then((task) => this.#trackTask(instance, task))
      .catch(async (error) => {
        this.#processings.delete(instanceId);

        this.#logger.errorFrom(error, `Failed to create task for instance (${instanceId})`);

        // 创建任务失败时向 Portal 释放，而不是直接删除本地记录；
        // 本地 KV 记录会在后续 Watch 同步发现 Server 不再下发时由 diff 清理。
        try {
          await this.#release(instanceId);
          this.#logger.info("Instance released after task creation failure", { instanceId });
        } catch (releaseError) {
          this.#logger.errorFrom(releaseError, `Failed to release instance after task creation failure (${instanceId})`);
        }
      });
  }

  async #acknowledge(id: string) {
    this.#logger.info("Acknowledging unconfirmed instance", { instanceId: id });

    try {
      await this.#portalMust.acknowledge(
        Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceAcknowledgeRequestSchema, {
          instanceId: id,
          status: SupervisorPortalPB.AcknowledgeStatus.OK,
        }),
      );

      this.#logger.info("Instance acknowledged", { instanceId: id });
    } catch (error) {
      this.#logger.errorFrom(error, `Failed to acknowledge instance (${id})`);
    }
  }

  async #release(instanceId: string) {
    await this.#portalMust.release(
      Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceReleaseRequestSchema, {
        instanceId,
      }),
    );
  }

  async #releaseAllRunningInstances() {
    for (const { key } of this.#kv.db.getRange({ start: Controller.INSTANCE_KEY_PREFIX })) {
      const instanceId = this.#instanceIdFromStorageKey(key);

      this.#logger.info("Releasing stale instance", { instanceId });

      try {
        await this.#release(instanceId);
      } catch (error) {
        this.#logger.warn("Failed to release stale instance", { instanceId, error });
      }
    }
  }

  async #sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async #trackTask(instance: Controller.RunningInstance, task: Orchestrator.Task) {
    this.#logger.info("Instance run started", {
      instanceId: instance.id,
      projectId: instance.projectId,
    });

    try {
      await task.closed;

      this.#logger.info("Instance run finished", {
        instanceId: instance.id,
        projectId: instance.projectId,
      });
    } catch (error) {
      this.#logger.errorFrom(error, `Instance run failed (${instance.id})`);
    } finally {
      this.#processings.delete(instance.id);

      try {
        await this.#release(instance.id);
        this.#logger.info("Instance released", { instanceId: instance.id });
      } catch (error) {
        this.#logger.errorFrom(error, `Failed to release instance (${instance.id})`);
      }
    }
  }

  #loadToRunningInstance(load: SupervisorPortalPB.LoadValid) {
    return {
      id: load.instanceId,
      projectId: load.projectId,
      projectResourceTier: this.#mapResourceTier(load.projectResourceTier),
      createTimestamp: new Date(Number(load.timestamp.seconds) * 1000 + load.timestamp.nanos / 1_000_000),
    } satisfies Controller.RunningInstance as Controller.RunningInstance;
  }

  #mapResourceTier(tier: ProjectPB.ProjectResourceTier) {
    switch (tier) {
      case ProjectPB.ProjectResourceTier.MINIMUM:
        return "minimal";
      case ProjectPB.ProjectResourceTier.STANDARD:
        return "standard";
      case ProjectPB.ProjectResourceTier.PERFORMANCE:
        return "performance";
      default:
        throw new Error(`Unsupported project resource tier: ${tier}`);
    }
  }

  #instanceStorageKey(instanceId: string) {
    return `${Controller.INSTANCE_KEY_PREFIX}${instanceId}`;
  }

  #instanceIdFromStorageKey(key: string) {
    return key.slice(Controller.INSTANCE_KEY_PREFIX.length);
  }
}

export namespace Controller {
  export const INSTANCE_KEY_PREFIX = "instance:";

  export type RunningInstance = {
    /**
     * 实例 ID
     */
    id: string;
    /**
     * 项目 ID
     */
    projectId: string;
    /**
     * 项目资源档位
     */
    projectResourceTier: "minimal" | "standard" | "performance";
    /**
     * 该实例的创建时间（在后端）
     */
    createTimestamp: Date;
  };
}
