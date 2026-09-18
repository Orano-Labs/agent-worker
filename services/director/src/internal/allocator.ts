import { Container } from "@aw/container";
import type { Logger } from "@aw/logging";
import { default as AsyncLock } from "async-lock";
import type { ProjectResourceTier } from "@/generated/prisma/enums";
import type { Leases } from "@/internal/leases";
import type { Repository } from "@/internal/repository";

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

export class Allocator extends Container.ServiceConstructable {
  #repository: Repository;
  #logger: Logger;
  #leases: Leases;
  #lock: AsyncLock;

  #pendings: Map<string, { resolve: (result: Allocator.PendingResult) => boolean; project: string; supervisor: string }>;

  constructor(...deps: [Logger, Repository, Leases]) {
    super();

    this.#repository = deps[1];
    this.#logger = deps[0].namespace("Allocator");
    this.#leases = deps[2];
    this.#pendings = new Map();
    this.#lock = new AsyncLock();
  }

  async allocate(projectId: string) {
    return this.#lock.acquire(projectId, async () => {
      const instance = await this.#repository.client.instance.findFirst({
        where: {
          projectId: projectId,
          confirmed: true,
        },
      });

      if (instance) {
        return {
          id: instance.id,
          supervisor: instance.supervisorId,
        };
      }

      const project = await this.#repository.client.project.findUniqueOrThrow({
        where: {
          id: projectId,
        },
      });

      if (project.deleteTime !== null) {
        throw new Allocator.AllocateError(Allocator.AllocateError.Code.Aborted, `Project "${projectId}" is marked as deleted.`);
      }

      const exclude = new Set<string>();
      const requiredCapacity = getTierWeight(project.resourceTier);

      for (let attempt = 1; attempt <= 3; attempt++) {
        const onlines = this.#leases.getAllLeases().filter((lease) => {
          return lease.online && !exclude.has(lease.supervisor);
        });

        if (onlines.length === 0) {
          throw new Allocator.AllocateError(Allocator.AllocateError.Code.NoSupervisor, "No online supervisor available.");
        }

        // biome-ignore format: x
        const candidates = await this.#candidates(onlines.map((lease) => lease.supervisor), requiredCapacity);

        if (candidates.length === 0) {
          throw new Allocator.AllocateError(Allocator.AllocateError.Code.NoCapacity, "No supervisor with sufficient capacity.");
        }

        let claimed: null | { id: string; projectId: string; supervisorId: string } = null;

        for (const candidate of candidates) {
          claimed = await this.#claim(projectId, candidate.id, requiredCapacity);

          if (claimed) {
            break;
          }
        }

        if (!claimed) {
          break;
        }

        this.#leases.getLease(claimed.supervisorId)?.notifyAssignmentListChanged();

        try {
          const result = await new Promise<Allocator.PendingResult>((resolve) => {
            const timer = setTimeout(() => resolve("timeout"), Allocator.ACK_TIMEOUT);

            let settled = false;

            this.#pendings.set(claimed.id, {
              supervisor: claimed.supervisorId,
              project: claimed.projectId,
              resolve: (result) => {
                if (settled) {
                  return false;
                }

                clearTimeout(timer);
                resolve(result);
                this.#pendings.delete(claimed.id);

                settled = true;

                return settled;
              },
            });
          });

          if (result === "timeout") {
            throw new Error(
              `Supervisor "${claimed.supervisorId}" did not confirm instance "${claimed.id}" within ${Allocator.ACK_TIMEOUT}ms`,
            );
          }

          if (result === "reject") {
            throw new Error(`Supervisor "${claimed.supervisorId}" rejected the allocation for project "${projectId}"`);
          }

          if (result === "aborted") {
            throw new Allocator.AllocateError(Allocator.AllocateError.Code.Aborted, `Allocation for project "${projectId}" was aborted.`);
          }

          const updated = await this.#repository.client.instance.updateMany({
            where: {
              id: claimed.id,
              confirmed: false,
              projectId,
            },
            data: {
              confirmed: true,
            },
          });

          if (updated.count === 0) {
            // biome-ignore format: x
            throw new Allocator.AllocateError(Allocator.AllocateError.Code.Aborted, `Allocation for project "${projectId}" was aborted during confirmation.`);
          }

          this.#logger.info("Instance allocated", {
            project: projectId,
            instance: claimed.id,
            supervisor: claimed.supervisorId,
          });

          this.#leases.getLease(claimed.supervisorId)?.notifyAssignmentListChanged();

          return {
            id: claimed.id,
            supervisor: claimed.supervisorId,
          };
        } catch (error) {
          exclude.add(claimed.supervisorId);

          if (error instanceof Allocator.AllocateError && error.code === Allocator.AllocateError.Code.Aborted) {
            this.#logger.warn(`Allocation aborted for project ${projectId} on supervisor ${claimed.supervisorId}`);
          } else {
            this.#logger.error(`Allocation failed for supervisor ${claimed.supervisorId}, retrying...`, {
              err: error,
            });
          }

          try {
            await this.#unclaim(claimed.id, projectId);
          } catch (rollbackErr) {
            this.#logger.error("Failed to rollback allocation capacity", { err: rollbackErr });
          }

          if (error instanceof Allocator.AllocateError && error.code === Allocator.AllocateError.Code.Aborted) {
            throw error;
          }
        }
      }

      throw new Allocator.AllocateError(Allocator.AllocateError.Code.Exhausted, "All allocation attempts failed.");
    });
  }

  async release(projectId: string, instanceId: string) {
    const pending = this.#pendings.get(instanceId);

    if (pending && pending.project === projectId && pending.resolve("aborted")) {
      return true;
    }

    return await this.#lock.acquire(projectId, async () => {
      const result = await this.#unclaim(instanceId, projectId);

      if (result) {
        this.#logger.info("Instance released, capacity restored", {
          id: instanceId,
          supervisor: result.supervisor,
        });

        this.#leases.getLease(result.supervisor)?.notifyAssignmentListChanged();
      }

      return !!result;
    });
  }

  async acknowledge(projectId: string, instanceId: string, ok: boolean) {
    const pending = this.#pendings.get(instanceId);

    if (pending && pending.project === projectId) {
      return pending.resolve(ok ? "ok" : "reject");
    }

    return false;
  }

  async #candidates(supervisors: string[], requiredCapacity: number) {
    return await this.#repository.client.supervisor.findMany({
      where: {
        id: {
          in: supervisors,
        },
        deleteTime: null,
        remainingCapacity: {
          gte: requiredCapacity,
        },
      },
      select: {
        id: true,
      },
      orderBy: {
        remainingCapacity: "desc",
      },
    });
  }

  async #claim(project: string, supervisor: string, requiredCapacity: number) {
    const capacityExhaustedError = new Error("capacity exhausted");

    try {
      return await this.#repository.client.$transaction(async (tx) => {
        const res = await tx.supervisor.updateMany({
          where: {
            id: supervisor,
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
          throw capacityExhaustedError;
        }

        return await tx.instance.create({
          data: {
            projectId: project,
            supervisorId: supervisor,
            confirmed: false,
          },
        });
      });
    } catch (error) {
      if (error === capacityExhaustedError) {
        return null;
      }

      throw error;
    }
  }

  async #unclaim(id: string, project: string) {
    return await this.#repository.client.$transaction(async (tx) => {
      const instance = await tx.instance.findFirst({
        where: {
          id: id,
          projectId: project,
        },
        include: {
          project: {
            select: {
              resourceTier: true,
            },
          },
        },
      });

      if (!instance) {
        return null;
      }

      const deleted = await tx.instance.deleteMany({
        where: {
          id: id,
        },
      });

      if (deleted.count === 0) {
        return null;
      }

      await tx.supervisor.update({
        where: {
          id: instance.supervisorId,
        },
        data: {
          remainingCapacity: {
            increment: getTierWeight(instance.project.resourceTier),
          },
        },
      });

      return {
        supervisor: instance.supervisorId,
      };
    });
  }

  protected override async initialize(signal: AbortSignal) {
    const c = await this.#repository.transaction(async (tx) => {
      const unconfirmed = await tx.client.instance.findMany({
        where: {
          confirmed: false,
        },
        include: {
          project: true,
        },
      });

      for (const inst of unconfirmed) {
        if (signal.aborted) {
          throw signal.reason;
        }

        await this.#unclaim(inst.id, inst.projectId);
      }

      return unconfirmed.length;
    });

    this.#logger.info("Cleaned up unconfirmed instances on init", { count: c });
  }
}

export namespace Allocator {
  export const ACK_TIMEOUT = 1_000 * 3;

  export type Allocation = {
    id: string;
    supervisor: string;
    supervisorLease?: Leases.Lease;
  };

  export type PendingResult = "ok" | "reject" | "timeout" | "aborted";

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
      /** 分配被中途终止/取消 */
      Aborted = "ABORTED",
    }
  }
}
