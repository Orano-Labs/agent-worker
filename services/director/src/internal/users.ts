import { Container } from "@aw/container";
import { Logger } from "@aw/logging";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { Database } from "@/internal/database";
import { UserTable } from "@/internal/database-schema";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export class Users extends Container.ServiceConstructable {
  #database: Database;
  #logger: Logger;

  constructor(...deps: [Database, Logger]) {
    super();

    this.#database = deps[0];
    this.#logger = deps[1].namespace("Users");
  }

  async create(input: Users.CreateInput) {
    const publicKey = Buffer.from(input.publicKey);
    const metadata = input.metadata == null ? null : Buffer.from(input.metadata);

    const user = await this.#database.client.transaction(async (tx) => {
      await tx.insert(UserTable).values({
        publicKey,
        metadata,
        disabled: input.disabled ?? false,
      });

      const [created] = await tx.select().from(UserTable).where(eq(UserTable.publicKey, publicKey)).limit(1);

      return created ?? null;
    });

    if (!user) {
      throw new Error("User was created but could not be loaded.");
    }

    this.#logger.debug("User created.", { id: user.id });

    return user;
  }

  async get(id: string) {
    const [user] = await this.#database.client
      .select()
      .from(UserTable)
      .where(and(eq(UserTable.id, id), isNull(UserTable.deleteTime)))
      .limit(1);

    return user ?? null;
  }

  async getByPublicKey(publicKey: Uint8Array) {
    const [user] = await this.#database.client
      .select()
      .from(UserTable)
      .where(and(eq(UserTable.publicKey, Buffer.from(publicKey)), isNull(UserTable.deleteTime)))
      .limit(1);

    return user ?? null;
  }

  async list(options: Users.ListOptions = {}) {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));

    const where = and(isNull(UserTable.deleteTime), options.disabled === undefined ? undefined : eq(UserTable.disabled, options.disabled));

    const [users, [total]] = await Promise.all([
      this.#database.client
        .select()
        .from(UserTable)
        .where(where)
        .orderBy(desc(UserTable.createTime))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.#database.client.select({ count: count() }).from(UserTable).where(where),
    ]);

    return {
      users,
      total: total?.count ?? 0,
    };
  }

  async update(id: string, input: Users.UpdateInput) {
    const data: Partial<Pick<Users.User, "metadata" | "disabled">> = {};

    if (input.metadata !== undefined) {
      data.metadata = input.metadata === null ? null : Buffer.from(input.metadata);
    }

    if (input.disabled !== undefined) {
      data.disabled = input.disabled;
    }

    if (Object.keys(data).length === 0) {
      return this.get(id);
    }

    await this.#database.client
      .update(UserTable)
      .set(data)
      .where(and(eq(UserTable.id, id), isNull(UserTable.deleteTime)));

    this.#logger.debug("User updated.", { id });

    return this.get(id);
  }

  async delete(id: string) {
    const [result] = await this.#database.client
      .update(UserTable)
      .set({ deleteTime: new Date() })
      .where(and(eq(UserTable.id, id), isNull(UserTable.deleteTime)));

    if (result.affectedRows === 0) {
      return false;
    }

    this.#logger.debug("User deleted.", { id });

    return true;
  }
}

export namespace Users {
  export type User = typeof UserTable.$inferSelect;

  export type CreateInput = {
    publicKey: Uint8Array;
    metadata?: Uint8Array | null;
    disabled?: boolean;
  };

  export type UpdateInput = {
    metadata?: Uint8Array | null;
    disabled?: boolean;
  };

  export type ListOptions = {
    page?: number;
    pageSize?: number;
    disabled?: boolean;
  };
}
