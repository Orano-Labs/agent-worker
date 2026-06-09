import { sql } from "drizzle-orm";
import { boolean, int, mysqlEnum, mysqlTable as table, timestamp, unique, varchar } from "drizzle-orm/mysql-core";
import { binary } from "@/supports/database/schema/utils";

const SHARED_COLUMNS = {
  get id() {
    return int("id").autoincrement().primaryKey();
  },
  get uid() {
    return binary("uid", { length: 16 }).default(sql`(UUID_TO_BIN(UUID(), 1))`).unique().notNull();
  },
  get createTimestamp() {
    return timestamp("create_timestamp").notNull().defaultNow();
  },
  get updateTimestamp() {
    return timestamp("update_timestamp").notNull().defaultNow().onUpdateNow();
  },
} as const;

const USERS_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,

  role: mysqlEnum("role", ["admin", "normal"]).default("normal").notNull(),
} as const;

const ISSUES_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,
} as const;

const ISSUE_COLLABORATORS_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,
} as const;

export const USERS_TABLE = table("users", USERS_TABLE_COLUMNS, () => {
  return [];
});

export const ISSUES_TABLE = table("issuses", ISSUES_TABLE_COLUMNS, () => {
  return [];
});

export const ISSUE_COLLABORATORS_TABLE = table("issue_collaborators", ISSUE_COLLABORATORS_TABLE_COLUMNS, () => {
  return [];
});

const AGENTS_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,

  /**
   * 智能体名称
   */
  name: varchar("name", { length: 255 }).notNull(),

  /**
   * 智能体预设模板包 ID (包括 Skills 和 MCP) 应该由外部系统管理并分配 ID
   */
  templateId: varchar("template_id", { length: 255 }),

  /**
   * 智能体记忆库 ID 应该由外部系统分配
   */
  memoryId: varchar("memory_id", { length: 255 }),

  /**
   * 智能体描述
   */
  description: varchar("description", { length: 600 }),
} as const;

const AGENT_ENV_VARIABLES_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,

  /**
   * 智能体 ID
   */
  agentId: int("agent_id")
    .references(() => AGENTS_TABLE.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    })
    .notNull(),

  /**
   * 环境变量 KEY
   */
  key: varchar("key", { length: 300 }).notNull(),

  /**
   * 环境变量 VALUE
   */
  value: varchar("value", { length: 600 }),

  /**
   * 如果环境变量是随着项目的属性动态生成的则需要在此处设置该环境变量生成器的 ID
   */
  generator: varchar("generator", { length: 255 }),
} as const;

export const AGENTS_TABLE = table("agents", AGENTS_TABLE_COLUMNS, () => {
  return [];
});

export const AGENT_ENV_VARIABLES_TABLE = table("agent_env_variables", AGENT_ENV_VARIABLES_TABLE_COLUMNS, (t) => {
  return [unique().on(t.agentId, t.key)];
});

const PROJECTS_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,

  /**
   * 如果该项目由某个 Agent 驱动，则需要在此处设置
   */
  agentId: int("agent_id").references(
    () => {
      return AGENTS_TABLE.id;
    },
    {
      onDelete: "restrict",
      onUpdate: "restrict",
    },
  ),

  /**
   * 项目名称
   */
  name: varchar("name", { length: 255 }).notNull(),

  /**
   * 项目描述
   */
  description: varchar("description", { length: 600 }),

  /**
   * 项目镜像 ID 存储着该项目的文件系统镜像
   */
  imageId: varchar("image_id", { length: 255 }).notNull(),

  /**
   * 该项目的所有者 ID
   */
  ownerId: int("owner_id").references(
    () => {
      return USERS_TABLE.id;
    },
    {
      onDelete: "restrict",
      onUpdate: "restrict",
    },
  ),

  /**
   * 存档时间；存档后项目已被设置为只读的并回收分配的所有资源
   */
  archiveTimestamp: timestamp("archive_timestamp"),

  /**
   * 资源规格
   *
   * - minimum 内存：1GB CPU：1Core 磁盘：1GB
   * - standard 内存：2GB CPU：2Core 磁盘：2GB
   * - performance 内存：4GB CPU：4Core 磁盘：4GB
   */
  resourceTier: mysqlEnum("resource_tier", ["minimum", "standard", "performance"]),
} as const;

const PROJECT_MEMBERS_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,

  /**
   * 项目 ID
   */
  projectId: int("project_id").references(() => {
    return PROJECTS_TABLE.id;
  }),

  /**
   * 用户 ID
   */
  userId: int("user_id").references(() => {
    return USERS_TABLE.id;
  }),

  /**
   * 是否启用
   */
  enabled: boolean("enabled").notNull().default(true),
} as const;

const PROJECT_SESSIONS_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,

  /**
   * 项目 ID
   */
  projectId: int("project_id").references(() => {
    return PROJECTS_TABLE.id;
  }),

  /**
   * 该会话的创建者
   */
  creator: int("creator").references(() => {
    return USERS_TABLE.id;
  }),
} as const;

export const PROJECTS_TABLE = table("projects", PROJECTS_TABLE_COLUMNS, () => {
  return [];
});

export const PROJECT_MEMBERS_TABLE = table("project_members", PROJECT_MEMBERS_TABLE_COLUMNS, (t) => {
  return [unique().on(t.projectId, t.userId)];
});

export const PROJECT_SESSIONS_TABLE = table("project_sessions", PROJECT_SESSIONS_TABLE_COLUMNS, (t) => {
  return [];
});

//
// 基础设施相关表
//

const SUPERVISORS_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,

  /**
   * 节点自定义名称
   */
  name: varchar("name", { length: 255 }).notNull(),

  /**
   * 主机注册密钥
   */
  publicKey: varchar("public_key", { length: 255 }).notNull(),

  /**
   * 激活状态
   * 'active': 已启用，允许连接和调度
   * 'suspended': 临时停用，不应该被调度
   * 'inactive': 已禁用，不允许连接
   */
  status: mysqlEnum("status", ["active", "suspended", "inactive"]).default("suspended").notNull(),

  /**
   * 删除时间
   */
  deleteTimestamp: timestamp("delete_timestamp"),
} as const;

export const SUPERVISORS_TABLE = table("supervisors", SUPERVISORS_TABLE_COLUMNS, () => {
  return [];
});
