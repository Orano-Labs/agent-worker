import { createId } from "@orama/cuid2";
import { sql } from "drizzle-orm";
import {
  AnyMySqlColumn,
  boolean,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  timestamp,
  uniqueIndex,
  varbinary,
  varchar,
} from "drizzle-orm/mysql-core";

const CHARSET = "utf8mb4" as const;
const COLLATION = "utf8mb4_unicode_ci" as const;

type Utf8mb4Builder = {
  charSet(charSet: typeof CHARSET): {
    collate(collation: typeof COLLATION): unknown;
  };
};

const utf8mb4 = <T extends Utf8mb4Builder>(column: T): T => {
  return column.charSet(CHARSET).collate(COLLATION) as T;
};

export const TemplateStatusEnum = {
  draft: "DRAFT",
  published: "PUBLISHED",
  archived: "ARCHIVED",
} as const;

export const ProjectResourceTierEnum = {
  minimum: "MINIMUM",
  standard: "STANDARD",
  performance: "PERFORMANCE",
} as const;

export const SupervisorStatusEnum = {
  /** Accepts new scheduling. */
  active: "ACTIVE",
  /** Stops new scheduling while existing deployments finish; used before deletion. */
  draining: "DRAINING",
  /** Administratively disabled and not schedulable; not tied to deletion. */
  disabled: "DISABLED",
} as const;

// biome-ignore format: x
const TemplateStatusValues = [TemplateStatusEnum.draft, TemplateStatusEnum.published, TemplateStatusEnum.archived] as const;

// biome-ignore format: x
const ProjectResourceTierValues = [ProjectResourceTierEnum.minimum, ProjectResourceTierEnum.standard, ProjectResourceTierEnum.performance]  as const;

// biome-ignore format: x
const SupervisorStatusValues = [SupervisorStatusEnum.active, SupervisorStatusEnum.draining, SupervisorStatusEnum.disabled] as const;

export const UserTable = mysqlTable(
  "user",
  {
    /**
     * biome-ignore format: x
     */
    id: utf8mb4(varchar({ length: 24 })).primaryKey().$defaultFn(() => createId()),
    /**
     * biome-ignore format: x
     */
    publicKey: varbinary("public_key", { length: 128 }).$type<Buffer>().notNull(),
    /**
     * biome-ignore format: x
     */
    metadata: varbinary("metadata", { length: 2048 }).$type<Buffer>(),
    /**
     * biome-ignore format: x
     */
    createTime: timestamp("create_time", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    /**
     * biome-ignore format: x
     */
    updateTime: timestamp("update_time", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`).$onUpdate(() => new Date()),
    /**
     * biome-ignore format: x
     */
    deleteTime: timestamp("delete_time", { fsp: 3 }),
    /**
     * biome-ignore format: x
     */
    disabled: boolean().notNull().default(false),
  },
  (t) => [uniqueIndex("user_public_key_key").on(t.publicKey)],
);

export const SupervisorTable = mysqlTable(
  "supervisor",
  {
    /**
     * biome-ignore format: x
     */
    id: utf8mb4(varchar({ length: 24 })).primaryKey().$defaultFn(() => createId()),
    /**
     * biome-ignore format: x
     */
    publicKey: varbinary("public_key", { length: 128 }).$type<Buffer>().notNull(),
    /**
     * biome-ignore format: x
     */
    metadata: varbinary("metadata", { length: 2048 }).$type<Buffer>(),
    /**
     * biome-ignore format: x
     */
    createTime: timestamp("create_time", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    /**
     * biome-ignore format: x
     */
    updateTime: timestamp("update_time", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`).$onUpdate(() => new Date()),
    /**
     * biome-ignore format: x
     */
    deleteTime: timestamp("delete_time", { fsp: 3 }),
    /**
     * biome-ignore format: x
     */
    status: utf8mb4(mysqlEnum("status", SupervisorStatusValues)).notNull().default(SupervisorStatusEnum.active),
    /**
     * biome-ignore format: x
     */
    capacity: int().notNull().default(8),
    /**
     * biome-ignore format: x
     */
    remainingCapacity: int("remaining_capacity").notNull().default(8),
    /**
     * biome-ignore format: x
     */
    ownerId: utf8mb4(varchar("owner_id", { length: 24 })).references(() => UserTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
  },
  (t) => [uniqueIndex("supervisor_public_key_key").on(t.publicKey)],
);

export const TemplateTable = mysqlTable(
  "template",
  {
    /**
     * biome-ignore format: x
     */
    id: utf8mb4(varchar({ length: 24 })).primaryKey().$defaultFn(() => createId()),
    /**
     * biome-ignore format: x
     */
    metadata: varbinary("metadata", { length: 2048 }).$type<Buffer>(),
    /**
     * biome-ignore format: x
     */
    status: utf8mb4(mysqlEnum("status", TemplateStatusValues)).notNull().default(TemplateStatusEnum.draft),
    /**
     * biome-ignore format: x
     */
    createTime: timestamp("create_time", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    /**
     * biome-ignore format: x
     */
    updateTime: timestamp("update_time", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`).$onUpdate(() => new Date()),
    /**
     * biome-ignore format: x
     */
    deleteTime: timestamp("delete_time", { fsp: 3 }),
    /**
     * biome-ignore format: x
     */
    sourceTemplateId: utf8mb4(varchar("source_template_id", { length: 24 })).references((): AnyMySqlColumn => TemplateTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
  },
  () => [],
);

export const ProjectTable = mysqlTable(
  "project",
  {
    /**
     * biome-ignore format: x
     */
    id: utf8mb4(varchar({ length: 24 })).primaryKey().$defaultFn(() => createId()),
    /**
     * biome-ignore format: x
     */
    metadata: varbinary("metadata", { length: 2048 }).$type<Buffer>(),
    /**
     * biome-ignore format: x
     */
    createTime: timestamp("create_time", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    /**
     * biome-ignore format: x
     */
    updateTime: timestamp("update_time", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`).$onUpdate(() => new Date()),
    /**
     * biome-ignore format: x
     */
    deleteTime: timestamp("delete_time", { fsp: 3 }),
    /**
     * biome-ignore format: x
     */
    resourceTier: utf8mb4(mysqlEnum("resource_tier", ProjectResourceTierValues)).notNull().default(ProjectResourceTierEnum.minimum),
    /**
     * biome-ignore format: x
     */
    ownerId: utf8mb4(varchar("owner_id", { length: 24 })).notNull().references(() => UserTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    /**
     * biome-ignore format: x
     */
    templateId: utf8mb4(varchar("template_id", { length: 24 })).references(() => TemplateTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    /**
     * biome-ignore format: x
     */
    supervisorId: utf8mb4(varchar("supervisor_id", { length: 24 })).references(() => SupervisorTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    /**
     * biome-ignore format: x
     */
    workspace: utf8mb4(varchar("workspace", { length: 1024 })),
  },
  () => [],
);

export const DeploymentTable = mysqlTable(
  "deployment",
  {
    /**
     * biome-ignore format: x
     */
    id: utf8mb4(varchar({ length: 24 })).primaryKey().$defaultFn(() => createId()),
    /**
     * biome-ignore format: x
     */
    projectId: utf8mb4(varchar("project_id", { length: 24 })).notNull().references(() => ProjectTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    /**
     * biome-ignore format: x
     */
    supervisorId: utf8mb4(varchar("supervisor_id", { length: 24 })).notNull().references(() => SupervisorTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    /**
     * biome-ignore format: x
     */
    confirmed: boolean().notNull().default(false),
    /**
     * biome-ignore format: x
     */
    createTime: timestamp("create_time", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [uniqueIndex("deployment_project_id_key").on(t.projectId), index("deployment_supervisor_id_idx").on(t.supervisorId)],
);
