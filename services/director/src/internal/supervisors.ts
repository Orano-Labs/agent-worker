import { Container } from "@aw/container";
import { Logger } from "@aw/logging";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { Database } from "@/internal/database";
import { DeploymentTable, SupervisorStatusEnum, SupervisorTable } from "@/internal/database-schema";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export class Supervisors extends Container.ServiceConstructable {
  #database: Database;
  #logger: Logger;

  constructor(...deps: [Database, Logger]) {
    super();

    this.#database = deps[0];
    this.#logger = deps[1].namespace("Supervisors");
  }

  async create(input: Supervisors.CreateInput) {
    const publicKey = Buffer.from(input.publicKey);
    const metadata = input.metadata == null ? null : Buffer.from(input.metadata);
    const capacity = input.capacity === undefined ? undefined : Math.max(1, Math.floor(input.capacity));

    const supervisor = await this.#database.client.transaction(async (tx) => {
      await tx.insert(SupervisorTable).values({
        publicKey,
        metadata,
        status: input.status ?? SupervisorStatusEnum.active,
        capacity,
        remainingCapacity: capacity,
        ownerId: input.ownerId ?? null,
      });

      const [created] = await tx.select().from(SupervisorTable).where(eq(SupervisorTable.publicKey, publicKey)).limit(1);

      return created ?? null;
    });

    if (!supervisor) {
      throw new Error("Supervisor was created but could not be loaded.");
    }

    this.#logger.debug("Supervisor created.", { id: supervisor.id });

    return supervisor;
  }

  async get(id: string) {
    const [supervisor] = await this.#database.client
      .select()
      .from(SupervisorTable)
      .where(and(eq(SupervisorTable.id, id), isNull(SupervisorTable.deleteTime)))
      .limit(1);

    return supervisor ?? null;
  }

  async getByPublicKey(publicKey: Uint8Array) {
    const [supervisor] = await this.#database.client
      .select()
      .from(SupervisorTable)
      .where(and(eq(SupervisorTable.publicKey, Buffer.from(publicKey)), isNull(SupervisorTable.deleteTime)))
      .limit(1);

    return supervisor ?? null;
  }

  async list(options: Supervisors.ListOptions = {}) {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));

    const where = and(
      isNull(SupervisorTable.deleteTime),
      options.ownerId === undefined
        ? undefined
        : options.ownerId === null
          ? isNull(SupervisorTable.ownerId)
          : eq(SupervisorTable.ownerId, options.ownerId),
    );

    const [supervisors, [total]] = await Promise.all([
      this.#database.client
        .select()
        .from(SupervisorTable)
        .where(where)
        .orderBy(desc(SupervisorTable.createTime))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.#database.client.select({ count: count() }).from(SupervisorTable).where(where),
    ]);

    return {
      supervisors,
      total: total?.count ?? 0,
    };
  }

  async update(id: string, input: Supervisors.UpdateInput) {
    const metadata = input.metadata === undefined ? undefined : input.metadata === null ? null : Buffer.from(input.metadata);
    const capacity = input.capacity === undefined ? undefined : Math.max(1, Math.floor(input.capacity));

    if (metadata === undefined && capacity === undefined && input.status === undefined) {
      return this.get(id);
    }

    const supervisor = await this.#database.client.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(SupervisorTable)
        .where(and(eq(SupervisorTable.id, id), isNull(SupervisorTable.deleteTime)))
        .limit(1);

      if (!existing) {
        return null;
      }

      const data: Partial<Pick<Supervisors.Supervisor, "metadata" | "status" | "capacity" | "remainingCapacity">> = {};

      if (metadata !== undefined) {
        data.metadata = metadata;
      }

      if (input.status !== undefined) {
        data.status = input.status;
      }

      if (capacity !== undefined) {
        const used = Math.max(0, existing.capacity - existing.remainingCapacity);

        if (capacity < used) {
          throw new Error(`Supervisor capacity cannot be lower than its used capacity (${used}).`);
        }

        data.capacity = capacity;
        data.remainingCapacity = capacity - used;
      }

      await tx
        .update(SupervisorTable)
        .set(data)
        .where(and(eq(SupervisorTable.id, id), isNull(SupervisorTable.deleteTime)));

      const [updated] = await tx
        .select()
        .from(SupervisorTable)
        .where(and(eq(SupervisorTable.id, id), isNull(SupervisorTable.deleteTime)))
        .limit(1);

      return updated ?? null;
    });

    if (supervisor) {
      this.#logger.debug("Supervisor updated.", { id });
    }

    return supervisor;
  }

  async delete(id: string) {
    const deleted = await this.#database.client.transaction(async (tx) => {
      const [supervisor] = await tx
        .select({ id: SupervisorTable.id })
        .from(SupervisorTable)
        .where(and(eq(SupervisorTable.id, id), isNull(SupervisorTable.deleteTime)))
        .limit(1);

      if (!supervisor) {
        return false;
      }

      const [deployment] = await tx
        .select({ id: DeploymentTable.id })
        .from(DeploymentTable)
        .where(eq(DeploymentTable.supervisorId, id))
        .limit(1);

      if (deployment) {
        throw new Supervisors.DeleteConflictError("Supervisor still has deployments.");
      }

      await tx
        .update(SupervisorTable)
        .set({ deleteTime: new Date() })
        .where(and(eq(SupervisorTable.id, id), isNull(SupervisorTable.deleteTime)));

      return true;
    });

    if (deleted) {
      this.#logger.debug("Supervisor deleted.", { id });
    }

    return deleted;
  }
}

export namespace Supervisors {
  export class DeleteConflictError extends Error {
    get name() {
      return "SupervisorDeleteConflictError";
    }
  }

  export type Supervisor = typeof SupervisorTable.$inferSelect;
  export type Status = Supervisor["status"];

  export type CreateInput = {
    publicKey: Uint8Array;
    metadata?: Uint8Array | null;
    status?: Status;
    capacity?: number;
    ownerId?: string | null;
  };

  export type UpdateInput = {
    metadata?: Uint8Array | null;
    status?: Status;
    capacity?: number;
  };

  export type ListOptions = {
    page?: number;
    pageSize?: number;
    ownerId?: string | null;
  };
}
