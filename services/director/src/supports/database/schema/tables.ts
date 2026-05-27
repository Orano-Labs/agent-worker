import { sql } from "drizzle-orm";
import { binary, mysqlEnum, mysqlTable as table, text, timestamp, varchar } from "drizzle-orm/mysql-core";

const SHARED_COLUMNS = {
  get id() {
    return binary("id", { length: 16 }).primaryKey().default(sql`(UUID_TO_BIN(UUID(), 1))`);
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

  role: mysqlEnum("role", ["admin", "normal"]).default("normal"),
} as const;

const ISSUES_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,
} as const;

const ISSUE_COLLABORATORS_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,
} as const;

const TEMPLATES_TABLE_COLUMNS = {
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

export const TEMPLATES_TABLE = table("templates", TEMPLATES_TABLE_COLUMNS, () => {
  return [];
});

//
// 基础设施相关表
//

const SUPERVISIORS_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,

  /**
   * 节点自定义名称
   */
  name: varchar("name", { length: 255 }).notNull(),

  /**
   * 主机注册密钥
   */
  publicKey: binary("public_key", { length: 32 }).notNull(),

  /**
   * 激活状态
   * 'active': 已启用，允许连接和调度
   * 'suspended': 临时停用，不应该被调度
   */
  status: mysqlEnum("status", ["active", "suspended"]).default("suspended").notNull(),
} as const;

export const SUPERVISIORS_TABLE = table("supervisiors", SUPERVISIORS_TABLE_COLUMNS, () => {
  return [];
});
