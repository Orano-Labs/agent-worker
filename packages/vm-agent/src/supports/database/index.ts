import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { Table } from "drizzle-orm/table";

import type { schema } from "./schema";

type Model<T extends Table> = InferInsertModel<T>;
type ModelRaw<T extends Table> = InferSelectModel<T, { dbColumnNames: true }>;
type ModelInsert<T extends Table> = InferInsertModel<T>;

export type DBSession = Model<typeof schema.SESSIONS_TABLE>;
export type DBSessionRaw = ModelRaw<typeof schema.SESSIONS_TABLE>;
export type DBSessionInsert = ModelInsert<typeof schema.SESSIONS_TABLE>;
