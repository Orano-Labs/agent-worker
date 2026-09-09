import type { ProjectResourceTier } from "@/generated/prisma/enums";
import { Container } from "@/helpers/container";
import { Result } from "@/helpers/result";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";
import { Tunnel } from "./tunnel";

const getTierWeight = (tier: ProjectResourceTier) => {
  switch (tier) {
    case "Performance":
      return 4;
    case "Standard":
      return 2;
    case "Minimum":
      return 1;
  }
};

export class Allocator {
  #repository: Repository;
  #logger: Logger;

  #leases: Map<string, Allocator.Lease>;
  #allocations: Map<string, Promise<Allocator.AllocationResult>>;
  #pending: Map<string, Allocator.Pending>;
  #releasing: Map<string, Promise<void>>;
  #listeners: Map<string, Set<() => void>>;

  constructor() {
    this.#repository = Container.inject(Repository);
    this.#logger = Container.inject(Logger).scope("Allocator");
    this.#leases = new Map();
    this.#allocations = new Map();
    this.#pending = new Map();
    this.#releasing = new Map();
    this.#listeners = new Map();
  }

  async allocate(project: string) {
    // 如果正在进行 release，等待 release 完成
    await this.#releasing.get(project)?.catch(() => {});

    // 合并并发分配请求
    let allocation = this.#allocations.get(project);

    if (!allocation) {
      allocation = (async () => {
        try {
          return await this.#allocate(project);
        } finally {
          this.#allocations.delete(project);
        }
      })();

      this.#allocations.set(project, allocation);
    }

    return await allocation;
  }

  async release(id: string, supervisor: string) {
    const instance = await this.#repository.client.instance.findUnique({
      where: {
        id: id,
        supervisorId: supervisor,
        confirmed: true,
      },
      include: {
        project: {
          select: {
            id: true,
            resourceTier: true,
          },
        },
      },
    });

    if (!instance) return;

    const projectId = instance.projectId;

    let releasePromise = this.#releasing.get(projectId);

    if (!releasePromise) {
      releasePromise = (async () => {
        try {
          await this.#repository.client.$transaction(async (tx) => {
            const deleted = await tx.instance.deleteMany({
              where: {
                id,
                supervisorId: supervisor,
              },
            });

            if (deleted.count > 0) {
              const capacity = getTierWeight(instance.project.resourceTier);

              await tx.supervisor.update({
                where: { id: supervisor },
                data: {
                  remainingCapacity: {
                    increment: capacity,
                  },
                },
              });

              this.#logger.info("Instance released, capacity restored", { id, supervisor, capacity });
            }
          });

          this.#notify(supervisor);
        } finally {
          this.#releasing.delete(projectId);
        }
      })();

      this.#releasing.set(projectId, releasePromise);
    }

    await releasePromise;
  }

  getLease(supervisor: string) {
    return this.#leases.get(supervisor);
  }

  getOrCreateLease(supervisor: string, processId: string) {
    let lease = this.#leases.get(supervisor);

    // 心跳携带的 process_id 变了,说明该 Supervisor 进程已经重启:
    // 旧 Lease 内的 Tunnel Socket 可能已假死(对端进程已不存在却未收到断开事件),
    // 必须立即销毁并重建,避免请求被转发到这些假死 Socket 上。
    if (lease && lease.processId !== processId) {
      this.#logger.warn("Supervisor restarted, replacing stale lease and tunnel", {
        supervisor,
        oldProcessId: lease.processId,
        newProcessId: processId,
      });

      lease.expire();
      lease = undefined;
    }

    if (!lease) {
      lease = new Allocator.Lease(supervisor, processId, () => {
        this.#leases.delete(supervisor);
      });

      this.#leases.set(supervisor, lease);
    }

    return lease;
  }

  getPending(instance: string) {
    return this.#pending.get(instance);
  }

  onChange(supervisor: string, listener: () => void) {
    let listeners = this.#listeners.get(supervisor);

    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(supervisor, listeners);
    }

    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  #notify(supervisor: string) {
    const listeners = this.#listeners.get(supervisor);

    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        this.#logger.error("Allocation change listener failed", { err: error, supervisor });
      }
    }
  }

  async #allocate(project: string) {
    const instance = await this.#repository.client.instance.findFirst({
      where: {
        projectId: project,
        confirmed: true,
      },
    });

    if (instance) {
      return { id: instance.id, supervisor: instance.supervisorId };
    }

    const projectData = await this.#repository.client.project.findUniqueOrThrow({
      where: {
        id: project,
      },
    });

    const exclude = new Set<string>();
    const requiredCapacity = getTierWeight(projectData.resourceTier);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const onlineSupervisors = Array.from(this.#leases.keys()).filter((id) => !exclude.has(id));

      if (onlineSupervisors.length === 0) {
        throw new Allocator.AllocateError(Allocator.AllocateError.Code.NoSupervisor, "No online supervisor available.");
      }

      const candidates = await this.#repository.client.supervisor.findMany({
        where: {
          id: {
            in: onlineSupervisors,
          },
          deleteTime: null,
          remainingCapacity: {
            gte: requiredCapacity,
          },
        },
        select: {
          id: true,
        },
      });

      if (candidates.length === 0) {
        throw new Allocator.AllocateError(Allocator.AllocateError.Code.NoCapacity, "No supervisor with sufficient capacity.");
      }

      const claimed = await (async () => {
        for (const candidate of candidates) {
          try {
            return await this.#repository.client.$transaction(async (tx) => {
              const res = await tx.supervisor.updateMany({
                where: {
                  id: candidate.id,
                  remainingCapacity: {
                    gte: requiredCapacity,
                  },
                },
                data: {
                  remainingCapacity: {
                    decrement: requiredCapacity,
                  },
                },
              });

              if (res.count === 0) {
                throw new Error("CAPACITY_EXHAUSTED");
              }

              return await tx.instance.create({
                data: {
                  projectId: project,
                  supervisorId: candidate.id,
                  confirmed: false,
                },
              });
            });
          } catch {}
        }
      })();

      if (claimed) {
        this.#notify(claimed.supervisorId);

        try {
          const pending = new Allocator.Pending(Allocator.ACK_TIMEOUT);

          if (this.#pending.has(claimed.id)) {
            throw new Error(`Instance "${claimed.id}" already has a pending acknowledgment`);
          }

          this.#pending.set(claimed.id, pending);

          const result = await pending.promise.finally(() => {
            this.#pending.delete(claimed.id);
          });

          if (result === "timeout") {
            throw new Error(
              `Supervisor "${claimed.supervisorId}" did not confirm instance "${claimed.id}" within ${Allocator.ACK_TIMEOUT}ms`,
            );
          }

          if (result === "reject") {
            throw new Error(`Supervisor "${claimed.supervisorId}" rejected the allocation for project "${project}"`);
          }

          await this.#repository.client.instance.update({
            where: {
              id: claimed.id,
              confirmed: false,
            },
            data: {
              confirmed: true,
            },
          });

          this.#logger.info("Instance allocated", {
            project,
            instance: claimed.id,
            supervisor: claimed.supervisorId,
          });

          this.#notify(claimed.supervisorId);

          return {
            id: claimed.id,
            supervisor: claimed.supervisorId,
          };
        } catch (error) {
          exclude.add(claimed.supervisorId);

          this.#logger.error(`Allocation failed for supervisor ${claimed.supervisorId}, retrying...`, {
            err: error,
          });

          await this.#repository.client
            .$transaction([
              this.#repository.client.instance.deleteMany({
                where: {
                  id: claimed.id,
                  confirmed: false,
                },
              }),
              this.#repository.client.supervisor.update({
                where: {
                  id: claimed.supervisorId,
                },
                data: {
                  remainingCapacity: {
                    increment: requiredCapacity,
                  },
                },
              }),
            ])
            .catch((rollbackErr) => {
              this.#logger.error("Failed to rollback allocation capacity", { err: rollbackErr });
            });
        }
      }
    }

    throw new Allocator.AllocateError(Allocator.AllocateError.Code.Exhausted, "All allocation attempts failed.");
  }

  async init() {
    try {
      await this.#repository.transaction(async (tx) => {
        const unconfirmed = await tx.client.instance.findMany({
          where: {
            confirmed: false,
          },
          include: {
            project: true,
          },
        });

        for (const inst of unconfirmed) {
          await tx.client.instance.delete({
            where: {
              id: inst.id,
            },
          });

          await tx.client.supervisor.update({
            where: {
              id: inst.supervisorId,
            },
            data: {
              remainingCapacity: {
                increment: getTierWeight(inst.project.resourceTier),
              },
            },
          });
        }

        this.#logger.info("Cleaned up unconfirmed instances on init", { count: unconfirmed.length });
      });
    } catch (error) {
      return Result.error(error);
    }

    return Result.ok();
  }
}

export namespace Allocator {
  export const ACK_TIMEOUT = 3_000 * 5;

  export type AllocationResult = {
    id: string;
    supervisor: string;
  };

  export class Lease {
    #timer: ReturnType<typeof setTimeout>;
    #expired: () => void;
    #tunnel: Tunnel;
    #processId: string;

    constructor(supervisor: string, processId: string, expired: () => void) {
      this.#expired = expired;
      this.#processId = processId;
      this.#timer = setTimeout(() => this.expire(), 3000).unref();
      this.#tunnel = new Tunnel(supervisor, 300);
    }

    get processId() {
      return this.#processId;
    }

    touch() {
      clearTimeout(this.#timer);

      this.#timer = setTimeout(() => {
        this.expire();
      }, 10_000).unref();
    }

    expire() {
      if (this.#timer) {
        clearTimeout(this.#timer);
      }

      this.#expired();
      this.#tunnel.destroy();
    }

    get tunnel() {
      return this.#tunnel;
    }
  }

  export class Pending {
    #promise: Promise<Pending.Result>;
    #promiseResolver: (result: Pending.Result) => void;

    #resolved: boolean;

    #timer: ReturnType<typeof setTimeout>;

    constructor(timeout: number) {
      this.#resolved = false;
      this.#promiseResolver = () => {
        throw new Error("Pending promise resolver is not initialized");
      };

      this.#promise = new Promise((resolve) => {
        this.#promiseResolver = (result) => {
          this.#resolved = true;

          resolve(result);
          clearTimeout(this.#timer);
        };
      });

      this.#timer = setTimeout(() => this.#promiseResolver("timeout"), timeout);
    }

    get promise() {
      return this.#promise;
    }

    acknowledge(ok: boolean) {
      if (this.#resolved) {
        throw new Error("Instance acknowledgment already settled (acknowledged or timed out)");
      }

      this.#promiseResolver(ok ? "ok" : "reject");
    }
  }

  export namespace Pending {
    export type Result = "ok" | "reject" | "timeout";
  }

  export class AllocateError extends Error {
    #code: Allocator.AllocateError.Code;

    constructor(code: Allocator.AllocateError.Code, message: string) {
      super(message);

      this.#code = code;
    }

    get code() {
      return this.#code;
    }
  }

  export namespace AllocateError {
    export enum Code {
      /** 没有在线的 Supervisor 可供分配 */
      NoSupervisor = "NO_SUPERVISOR",
      /** 在线 Supervisor 均无足够剩余容量 */
      NoCapacity = "NO_CAPACITY",
      /** 多次尝试分配均失败（超时或 Supervisor 拒绝） */
      Exhausted = "EXHAUSTED",
    }
  }
}
