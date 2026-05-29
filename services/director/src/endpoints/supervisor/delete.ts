import { ORPCError } from "@orpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { EndpointHelpers } from "@/endpoints/helpers";

export namespace SupervisorDelete {
  export const Input = z.object({
    params: z.object({
      id: z.uuid().describe("The unique identifier (UUID) of the supervisor agent."),
    }),
  });

  export const Output = z.object({});

  export const endpoint = EndpointHelpers.external
    .route({
      method: "DELETE",
      path: "/supervisor/{id}",
      description: "Delete a supervisor agent by marking it as deleted (soft delete).",
      tags: ["Supervisor"],
    })
    .input(Input)
    .output(Output)
    .handler(async (ctx) => {
      const db = EndpointHelpers.container.database;
      const uidBuffer = db.uuidToBuffer(ctx.input.params.id);

      const supervisor = await db.client
        .select()
        .from(db.schema.SUPERVISORS_TABLE)
        .where(and(eq(db.schema.SUPERVISORS_TABLE.uid, uidBuffer), isNull(db.schema.SUPERVISORS_TABLE.deleteTimestamp)))
        .limit(1);

      if (supervisor.length === 0) {
        throw new ORPCError("NOT_FOUND", {
          message: "Supervisor not found",
        });
      }

      await db.client
        .update(db.schema.SUPERVISORS_TABLE)
        .set({
          deleteTimestamp: new Date(),
        })
        .where(eq(db.schema.SUPERVISORS_TABLE.uid, uidBuffer));

      return {};
    });
}
