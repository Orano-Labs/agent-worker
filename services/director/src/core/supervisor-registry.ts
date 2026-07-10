import { Container } from "@/helpers/container";
import { Cache } from "@/internal/cache";
import { Logger } from "@/internal/logger";

export class SupervisorRegistry {
  #logger: Logger;
  #records: Map<string, SupervisorRegistry.Record>;
  #cache: Cache;

  constructor() {
    this.#logger = Container.inject(Logger).scope("SupervisorRegistry");
    this.#records = new Map();
    this.#cache = Container.inject(Cache);
  }

  #key(supervisorId: string) {
    return `supervisor:${supervisorId}:ts`;
  }

  /**
   * Record a metrics report from a supervisor.
   *
   * Online state (including metrics) stays in memory.  Only the last-report
   * and last-online timestamps are persisted to Redis so they survive a
   * restart.
   */
  report(supervisorId: string, metrics: SupervisorRegistry.Metrics) {
    const now = new Date();
    const prev = this.#records.get(supervisorId);
    const wasOffline = !prev || prev.state.type === "offline";

    if (wasOffline) {
      this.#logger.info("Supervisor came online", { supervisorId });
    }

    const record: SupervisorRegistry.Record = {
      state: {
        type: "online",
        since: prev?.state.type === "online" ? prev.state.since : now,
        metrics,
      },
      lastReportAt: now,
    };

    this.#records.set(supervisorId, record);
    this.#persistTimestamps(supervisorId, now, record.state.since);
  }

  /**
   * Mark a supervisor as offline, keeping the record in memory.
   *
   * Timestamps are also persisted to Redis so that {@link get} can return a
   * meaningful offline snapshot after a Director restart.
   */
  offline(supervisorId: string) {
    const prev = this.#records.get(supervisorId);

    if (!prev) {
      return;
    }

    // Already offline — nothing to do.
    if (prev.state.type === "offline") {
      return;
    }

    const lastOnlineAt = prev.state.since;

    this.#records.set(supervisorId, {
      state: {
        type: "offline",
        since: new Date(),
        lastOnlineAt,
      },
      lastReportAt: prev.lastReportAt,
    });

    this.#persistTimestamps(supervisorId, prev.lastReportAt, lastOnlineAt);

    this.#logger.info("Supervisor went offline", { supervisorId });
  }

  /**
   * Return a snapshot of the supervisor's state.
   *
   * Checks the in-memory store first.  If not found (e.g. after a restart),
   * falls back to Redis for the last-known timestamps.
   */
  async get(supervisorId: string) {
    const record = this.#records.get(supervisorId);

    if (record) {
      return record;
    }

    return this.#readTimestamps(supervisorId);
  }

  /** Convenience check: is the supervisor currently online? */
  isOnline(supervisorId: string) {
    return this.#records.get(supervisorId)?.state.type === "online";
  }

  async #readTimestamps(supervisorId: string): Promise<SupervisorRegistry.Record | undefined> {
    try {
      const data = await this.#cache.client.get(this.#key(supervisorId));

      if (!data) {
        return undefined;
      }

      const { lastReportAt, lastOnlineAt } = JSON.parse(data);

      return {
        state: {
          type: "offline",
          since: new Date(lastReportAt),
          lastOnlineAt: new Date(lastOnlineAt),
        },
        lastReportAt: new Date(lastReportAt),
      };
    } catch (err) {
      this.#logger.error("Failed to read supervisor timestamps from cache", {
        supervisorId,
        err,
      });

      return undefined;
    }
  }

  async #persistTimestamps(supervisorId: string, lastReportAt: Date, lastOnlineAt: Date) {
    try {
      await this.#cache.client.set(
        this.#key(supervisorId),
        JSON.stringify({
          lastReportAt: lastReportAt.toISOString(),
          lastOnlineAt: lastOnlineAt.toISOString(),
        }),
      );
    } catch (err) {
      this.#logger.error("Failed to persist supervisor timestamps to cache", {
        supervisorId,
        err,
      });
    }
  }
}

export namespace SupervisorRegistry {
  export type Metrics = {
    runningProjects: number;
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
  };

  export type OnlineState = {
    type: "online";
    since: Date;
    metrics: Metrics;
  };

  export type OfflineState = {
    type: "offline";
    since: Date;
    lastOnlineAt: Date;
  };

  export type Record = {
    state: OnlineState | OfflineState;
    lastReportAt: Date;
  };
}
