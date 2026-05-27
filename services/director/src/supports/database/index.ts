import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { Table } from "drizzle-orm/table";

import type { schema } from "./schema";

type Model<T extends Table> = InferInsertModel<T>;
type ModelRaw<T extends Table> = InferSelectModel<T, { dbColumnNames: true }>;
type ModelInsert<T extends Table> = InferInsertModel<T>;

export type DBUser = Model<typeof schema.USERS_TABLE>;
export type DBUserRaw = ModelRaw<typeof schema.USERS_TABLE>;
export type DBUserInsert = ModelInsert<typeof schema.USERS_TABLE>;

export type DBSupervisor = Model<typeof schema.SUPERVISORS_TABLE>;
export type DBSupervisorRaw = ModelRaw<typeof schema.SUPERVISORS_TABLE>;
export type DBSupervisorInsert = ModelInsert<typeof schema.SUPERVISORS_TABLE>;
