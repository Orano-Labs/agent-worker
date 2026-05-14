import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const SHARED_COLUMNS = {
  get createTimestamp() {
    return integer("create_timestamp").notNull().default(sql`(unixepoch())`);
  },
  get updateTimestamp() {
    return integer("update_timestamp")
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => {
        return sql`(unixepoch())`;
      });
  },
} as const;

const SESSIONS_TABLE_COLUMNS = {
  ...SHARED_COLUMNS,

  id: text("id").primaryKey(),
} as const;

export const SESSIONS_TABLE = sqliteTable("sessions", SESSIONS_TABLE_COLUMNS, (table) => {
  return [];
});
