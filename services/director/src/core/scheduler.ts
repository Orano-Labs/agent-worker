import { randomBytes } from "node:crypto";
import { default as AsyncLock } from "async-lock";
import { type Job, Queue, Worker } from "bullmq";
import { TunnelManager } from "@/core/tunnel-manager";
import { Container } from "@/helpers/container";
import { Cache } from "@/internal/cache";
import { Logger } from "@/internal/logger";
import type { Tunnel } from "./tunnel";

export class Scheduler {
  #cache: Cache;
  #queue: Queue<Scheduler.QueueJobData, void>;
  #worker: Worker<Scheduler.QueueJobData, void>;
  #logger: Logger;
  #enqueueLock: AsyncLock;
  #entries: Map<string, Scheduler.Entry>;
  #tunnels: TunnelManager;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Scheduler");
    this.#cache = Container.inject(Cache);
    this.#tunnels = Container.inject(TunnelManager);

    this.#entries = new Map();

    this.#queue = new Queue(Scheduler.QUEUE_NAME, {
      // @ts-expect-error
      connection: this.#cache.client,
      defaultJobOptions: {
        attempts: Scheduler.DEFAULT_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: Scheduler.BACKOFF_DELAY_MS,
        },
        removeOnComplete: {
          count: Scheduler.REMOVE_ON_COMPLETE_MAX,
        },
      },
    });

    this.#worker = new Worker(Scheduler.QUEUE_NAME, null, {
      // @ts-expect-error
      connection: this.#cache.client,
    });

    this.#enqueueLock = new AsyncLock();
  }

  async enqueue(projectId: string) {
    return this.#enqueueLock.acquire(projectId, async () => {
      const job = await this.#queue.getDeduplicationJobId(projectId);

      if (job) {
        return false;
      }

      await this.#queue.add(
        projectId,
        {
          projectId,
        },
        {
          deduplication: {
            id: projectId,
          },
        },
      );

      return true;
    });
  }

  async fetch(supervisorId: string) {
    const token = this.#randomHex(16);
    const job = await this.#worker.getNextJob(token);

    if (!job) {
      return null;
    }

    const projectId = job.data.projectId;
    const dispatchedAt = new Date();
    const tunnel = this.#tunnels.create(projectId, token);
    const entry: Scheduler.Entry = {
      job,
      token,
      tunnel,
      supervisor: supervisorId,
      dispatchedAt,
      extendTimer: setInterval(() => {
        entry.job.extendLock(token, Scheduler.LOCK_DURATION_MS).catch((err) => {
          this.#logger.error("Failed to extend job lock; cleaning up", {
            err,
            projectId: entry.job.data.projectId,
            token,
          });

          this.#cleanup(token);
        });
      }, Scheduler.EXTEND_LOCK_INTERVAL_MS),
      status: {
        type: "dispatched",
        timeoutTimer: setTimeout(() => {
          this.#logger.warn("Runner did not connect in time, returning job to queue", {
            projectId,
            token,
          });

          this.#cleanupTimeout(token);
        }, Scheduler.CONNECT_TIMEOUT_MS),
      },
    };

    this.#entries.set(token, entry);
    this.#logger.info("Job dispatched, waiting for runner connection", {
      projectId,
      token,
    });

    tunnel.once("online", () => {
      if (entry.status.type === "dispatched") {
        clearTimeout(entry.status.timeoutTimer);

        entry.status = {
          type: "connected",
          connectedAt: new Date(),
        };
      }
    });
    tunnel.once("offline", () => {
      this.#cleanup(token);
    });

    return entry;
  }

  #randomHex(bytes: number) {
    return Buffer.from(randomBytes(bytes)).toString("hex");
  }

  async #cleanupTimeout(token: string) {
    const entry = this.#entries.get(token);

    if (!entry) {
      return;
    }

    if (entry.status.type !== "dispatched") {
      return;
    }

    clearInterval(entry.extendTimer);
    clearTimeout(entry.status.timeoutTimer);

    this.#entries.delete(token);

    try {
      await entry.job.moveToDelayed(1000, token);

      this.#logger.info("Job returned to queue after connection timeout", {
        projectId: entry.job.data.projectId,
        token,
      });
    } catch (err) {
      this.#logger.error("Failed to return job to queue after timeout", {
        projectId: entry.job.data.projectId,
        token,
        err,
      });
    }
  }

  async #cleanup(token: string) {
    const entry = this.#entries.get(token);

    if (!entry) {
      return;
    }

    const projectId = entry.job.data.projectId;

    this.#entries.delete(token);

    clearInterval(entry.extendTimer);

    if (entry.status.type === "dispatched") {
      clearTimeout(entry.status.timeoutTimer);
    }

    try {
      await entry.job.moveToCompleted(null, token);
    } catch (err) {
      this.#logger.error("Failed to mark job as completed", {
        projectId,
        token,
        err,
      });
    }
  }

  async getStatus(projectId: string): Promise<Scheduler.ProjectStatus> {
    for (const entry of this.#entries.values()) {
      if (entry.job.data.projectId !== projectId) continue;

      if (entry.status.type === "connected") {
        return {
          type: "running",
          connectedAt: entry.status.connectedAt,
          runningDuration: Date.now() - entry.status.connectedAt.getTime(),
        };
      }

      return {
        type: "dispatched",
        dispatchedAt: entry.dispatchedAt,
        timeoutRemaining: Math.max(0, Scheduler.CONNECT_TIMEOUT_MS - (Date.now() - entry.dispatchedAt.getTime())),
      };
    }

    const queueJobs = await this.#queue.getJobs(["waiting", "delayed"], 0, -1, true);
    const pendingJob = queueJobs.find((job) => job.name === projectId);

    if (pendingJob) {
      return {
        type: "pending",
        enqueuedAt: new Date(pendingJob.timestamp),
      };
    }

    return { type: "idle" };
  }
}

export namespace Scheduler {
  export const CONNECT_TIMEOUT_MS = 30_000;
  export const EXTEND_LOCK_INTERVAL_MS = 15_000;
  export const LOCK_DURATION_MS = 30_000;

  export const DEFAULT_ATTEMPTS = 10;
  export const BACKOFF_DELAY_MS = 1000;
  export const REMOVE_ON_COMPLETE_MAX = 1000;

  export const QUEUE_NAME = "aw/scheduler/queue";

  export type EntryStatus =
    | {
        type: "dispatched";
        timeoutTimer: NodeJS.Timeout;
      }
    | {
        type: "connected";
        connectedAt: Date;
      };

  export type Entry = {
    job: Job<QueueJobData>;
    token: string;
    supervisor: string;
    dispatchedAt: Date;
    extendTimer: NodeJS.Timeout;
    status: EntryStatus;
    tunnel: Tunnel;
  };

  export type QueueJobData = {
    projectId: string;
  };

  export type Task = {
    projectId: string;
    token: string;
  };

  /** Project is waiting in the queue, not yet dispatched to any Supervisor. */
  export type ProjectStatusPending = {
    type: "pending";
    enqueuedAt: Date;
  };

  /** Project was fetched by a Supervisor but the sandbox WebSocket has not connected yet. */
  export type ProjectStatusDispatched = {
    type: "dispatched";
    dispatchedAt: Date;
    /** Remaining ms before the connection timeout fires and the job returns to queue. */
    timeoutRemaining: number;
  };

  /** Sandbox WebSocket is connected and the project is executing. */
  export type ProjectStatusRunning = {
    type: "running";
    connectedAt: Date;
    /** Elapsed ms since the sandbox connected. */
    runningDuration: number;
  };

  /** Project is not in any active lifecycle stage (never launched, or already completed). */
  export type ProjectStatusIdle = {
    type: "idle";
  };

  export type ProjectStatus = ProjectStatusPending | ProjectStatusDispatched | ProjectStatusRunning | ProjectStatusIdle;
}
