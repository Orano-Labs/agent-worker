import { Client, ProjectPB, SupervisorPortalPB } from "@aw/vm-director/sdk";
import { createGrpcWebTransport } from "@connectrpc/connect-node";
import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";
import { KVStorage } from "./kv-storage";

const IDENTITY = {
  type: "supervisor",
  id: "rcguu1932dfrw43o324v52my",
  privateKey: "302e020100300506032b6570042204206424dd57348652833a219457d053315755efc4a5311ebfe026bcca257752de52",
} as const;

const client = new Client(
  createGrpcWebTransport({
    baseUrl: "http://192.168.5.2:3008/grpc",
    httpVersion: "1.1",
  }) as unknown as ConstructorParameters<typeof Client>[0],
  IDENTITY,
);

export class Controller {
  #logger: Logger;
  #kv: KVStorage;
  #portal: ReturnType<Client["createSupervisorPortalService"]>;
  #processings: Map<string, Promise<void>>;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Controller");
    this.#kv = Container.inject(KVStorage);
    this.#portal = client.createSupervisorPortalService();
    this.#processings = new Map();
  }

  async init() {
    await this.#releaseAllRunningInstances();

    this.#logger.info("Controller initialized, starting supervisor portal watch stream");

    this.#watch().catch((error) => {
      this.#logger.errorFrom(error, "Watch loop terminated unexpectedly");
    });
  }

  async #watch() {
    while (true) {
      const stream = this.#portal.watch(Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceWatchRequestSchema, {}));

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
    const key = this.#instanceStorageKey(load.instanceId);

    if (this.#processings.has(load.instanceId)) {
      return;
    }

    if (this.#kv.db.get(key) !== undefined) {
      return;
    }

    this.#logger.info("Scheduling instance", {
      instanceId: load.instanceId,
      projectId: load.projectId,
      resourceTier: load.projectResourceTier,
    });

    const instance = this.#loadToRunningInstance(load);

    await this.#kv.db.put(key, instance);

    const processing = this.#processRunningInstance(instance)
      .catch((error) => {
        this.#logger.errorFrom(error, `Instance run failed (${load.instanceId})`);
      })
      .finally(async () => {
        this.#processings.delete(load.instanceId);

        try {
          await this.#release(load.instanceId).then(() => {
            this.#logger.info("Instance released", { instanceId: load.instanceId });
          });
        } catch (error) {
          this.#logger.errorFrom(error, `Failed to release instance (${load.instanceId})`);
        }
      });

    this.#processings.set(load.instanceId, processing);
  }

  async #acknowledge(id: string) {
    this.#logger.info("Acknowledging unconfirmed instance", { instanceId: id });

    try {
      await this.#portal.acknowledge(
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
    await this.#portal.release(
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

  async #processRunningInstance(instance: Controller.RunningInstance) {
    return new Promise<void>((resolve) => {
      const duration = 10_000;

      this.#logger.info("Instance run started (simulated)", {
        instanceId: instance.id,
        projectId: instance.projectId,
        duration,
      });

      setTimeout(() => {
        this.#logger.info("Instance run finished (simulated)", {
          instanceId: instance.id,
          projectId: instance.projectId,
        });

        resolve();
      }, duration);
    });
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
