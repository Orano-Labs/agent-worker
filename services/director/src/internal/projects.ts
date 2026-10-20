import { Container } from "@aw/container";
import { Logger } from "@aw/logging";
import { createId } from "@orama/cuid2";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { Database } from "@/internal/database";
import { InstanceTable, ProjectResourceTierEnum, ProjectTable } from "@/internal/database-schema";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export class Projects extends Container.ServiceConstructable {
  #database: Database;
  #logger: Logger;

  constructor(...deps: [Database, Logger]) {
    super();

    this.#database = deps[0];
    this.#logger = deps[1].namespace("Projects");
  }

  async create(input: Projects.CreateInput) {
    const id = input.id ?? createId();
    const metadata = input.metadata == null ? null : Buffer.from(input.metadata);

    const project = await this.#database.client.transaction(async (tx) => {
      await tx.insert(ProjectTable).values({
        id,
        metadata,
        ownerId: input.ownerId,
        resourceTier: input.resourceTier ?? ProjectResourceTierEnum.minimum,
        templateId: input.templateId ?? null,
        supervisorId: input.supervisorId ?? null,
        workspace: input.workspace ?? null,
      });

      const [created] = await tx.select().from(ProjectTable).where(eq(ProjectTable.id, id)).limit(1);

      return created ?? null;
    });

    if (!project) {
      throw new Error("Project was created but could not be loaded.");
    }

    this.#logger.debug("Project created.", { id: project.id });

    return project;
  }

  async get(id: string) {
    const [project] = await this.#database.client
      .select()
      .from(ProjectTable)
      .where(and(eq(ProjectTable.id, id), isNull(ProjectTable.deleteTime)))
      .limit(1);

    return project ?? null;
  }

  async list(options: Projects.ListOptions = {}) {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));

    const where = and(
      isNull(ProjectTable.deleteTime),
      options.ownerId === undefined ? undefined : eq(ProjectTable.ownerId, options.ownerId),
      options.templateId === undefined ? undefined : eq(ProjectTable.templateId, options.templateId),
      options.supervisorId === undefined ? undefined : eq(ProjectTable.supervisorId, options.supervisorId),
    );

    const [projects, [total]] = await Promise.all([
      this.#database.client
        .select()
        .from(ProjectTable)
        .where(where)
        .orderBy(desc(ProjectTable.createTime))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.#database.client.select({ count: count() }).from(ProjectTable).where(where),
    ]);

    return {
      projects,
      total: total?.count ?? 0,
    };
  }

  async update(id: string, input: Projects.UpdateInput) {
    const data: Partial<Pick<Projects.Project, "metadata" | "resourceTier" | "templateId" | "supervisorId" | "workspace">> = {};

    if (input.metadata !== undefined) {
      data.metadata = input.metadata === null ? null : Buffer.from(input.metadata);
    }

    if (input.resourceTier !== undefined) {
      data.resourceTier = input.resourceTier;
    }

    if (input.templateId !== undefined) {
      data.templateId = input.templateId;
    }

    if (input.supervisorId !== undefined) {
      data.supervisorId = input.supervisorId;
    }

    if (input.workspace !== undefined) {
      data.workspace = input.workspace;
    }

    if (Object.keys(data).length === 0) {
      return this.get(id);
    }

    await this.#database.client
      .update(ProjectTable)
      .set(data)
      .where(and(eq(ProjectTable.id, id), isNull(ProjectTable.deleteTime)));

    this.#logger.debug("Project updated.", { id });

    return this.get(id);
  }

  async hasInstance(id: string) {
    const [instance] = await this.#database.client
      .select({ id: InstanceTable.id })
      .from(InstanceTable)
      .where(eq(InstanceTable.projectId, id))
      .limit(1);

    return Boolean(instance);
  }

  async delete(id: string) {
    const [result] = await this.#database.client
      .update(ProjectTable)
      .set({ deleteTime: new Date() })
      .where(and(eq(ProjectTable.id, id), isNull(ProjectTable.deleteTime)));

    if (result.affectedRows === 0) {
      return false;
    }

    this.#logger.debug("Project deleted.", { id });

    return true;
  }
}

export namespace Projects {
  export type Project = typeof ProjectTable.$inferSelect;
  export type ResourceTier = Project["resourceTier"];

  export type CreateInput = {
    id?: string;
    ownerId: string;
    metadata?: Uint8Array | null;
    resourceTier?: ResourceTier;
    templateId?: string | null;
    supervisorId?: string | null;
    workspace?: string | null;
  };

  export type UpdateInput = {
    metadata?: Uint8Array | null;
    resourceTier?: ResourceTier;
    templateId?: string | null;
    supervisorId?: string | null;
    workspace?: string | null;
  };

  export type ListOptions = {
    page?: number;
    pageSize?: number;
    ownerId?: string;
    templateId?: string;
    supervisorId?: string;
  };

  export type ListResult = {
    projects: Project[];
    total: number;
  };
}
