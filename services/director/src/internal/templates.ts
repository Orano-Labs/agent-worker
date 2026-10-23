import { Container } from "@aw/container";
import { Logger } from "@aw/logging";
import { createId } from "@orama/cuid2";
import { and, count, desc, eq, isNull } from "drizzle-orm";

import { Database } from "@/internal/database";
import { TemplateStatusEnum, TemplateTable } from "@/internal/database-schema";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export class Templates extends Container.ServiceConstructable {
  #database: Database;
  #logger: Logger;

  constructor(...deps: [Database, Logger]) {
    super();

    this.#database = deps[0];
    this.#logger = deps[1].namespace("Templates");
  }

  async create(input: Templates.CreateInput = {}) {
    const id = input.id ?? createId();
    const metadata = input.metadata == null ? null : Buffer.from(input.metadata);

    const template = await this.#database.client.transaction(async (tx) => {
      await tx.insert(TemplateTable).values({
        id,
        metadata,
        status: input.status ?? TemplateStatusEnum.draft,
        sourceTemplateId: input.sourceTemplateId ?? null,
      });

      const [created] = await tx.select().from(TemplateTable).where(eq(TemplateTable.id, id)).limit(1);

      return created ?? null;
    });

    if (!template) {
      throw new Error("Template was created but could not be loaded.");
    }

    this.#logger.debug("Template created.", { id: template.id });

    return template;
  }

  async get(id: string) {
    const [template] = await this.#database.client
      .select()
      .from(TemplateTable)
      .where(and(eq(TemplateTable.id, id), isNull(TemplateTable.deleteTime)))
      .limit(1);

    return template ?? null;
  }

  async list(options: Templates.ListOptions = {}) {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));

    const where = and(
      isNull(TemplateTable.deleteTime),
      options.status === undefined ? undefined : eq(TemplateTable.status, options.status),
    );

    const [templates, [total]] = await Promise.all([
      this.#database.client
        .select()
        .from(TemplateTable)
        .where(where)
        .orderBy(desc(TemplateTable.createTime))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.#database.client.select({ count: count() }).from(TemplateTable).where(where),
    ]);

    return {
      templates,
      total: total?.count ?? 0,
    };
  }

  async update(id: string, input: Templates.UpdateInput) {
    const data: Partial<Pick<Templates.Template, "metadata" | "status">> = {};

    if (input.metadata !== undefined) {
      data.metadata = input.metadata === null ? null : Buffer.from(input.metadata);
    }

    if (input.status !== undefined) {
      data.status = input.status;
    }

    if (Object.keys(data).length === 0) {
      return this.get(id);
    }

    await this.#database.client
      .update(TemplateTable)
      .set(data)
      .where(and(eq(TemplateTable.id, id), isNull(TemplateTable.deleteTime)));

    this.#logger.debug("Template updated.", { id });

    return this.get(id);
  }

  async delete(id: string) {
    const [result] = await this.#database.client
      .update(TemplateTable)
      .set({ deleteTime: new Date() })
      .where(and(eq(TemplateTable.id, id), isNull(TemplateTable.deleteTime)));

    if (result.affectedRows === 0) {
      return false;
    }

    this.#logger.debug("Template deleted.", { id });

    return true;
  }
}

export namespace Templates {
  export type Template = typeof TemplateTable.$inferSelect;
  export type Status = Template["status"];

  export type CreateInput = {
    id?: string;
    metadata?: Uint8Array | null;
    status?: Status;
    sourceTemplateId?: string | null;
  };

  export type UpdateInput = {
    metadata?: Uint8Array | null;
    status?: Status;
  };

  export type ListOptions = {
    page?: number;
    pageSize?: number;
    status?: Status;
  };
}
