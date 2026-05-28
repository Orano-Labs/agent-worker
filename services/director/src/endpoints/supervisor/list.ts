import { count, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { EndpointHelpers } from "@/endpoints/helpers";

export namespace SupervisorList {
  export const Input = z.object({
    query: z.object({
      page: z.number().min(1).default(1).describe("The page number to retrieve."),
      size: z.number().min(1).max(200).default(10).describe("The number of items to retrieve per page."),
    }),
  });

  export const Output = z.object({
    body: z.object({
      data: z
        .object({
          uid: z.uuid().describe("The unique identifier (UUID) of the supervisor agent."),
          name: z.string().describe("The display name for the supervisor agent."),
          createTime: z.date().describe("The creation time of the supervisor agent."),
          updateTime: z.date().describe("The last update time of the supervisor agent."),
          status: z.enum(["active", "suspended", "inactive"]).describe("The status of the supervisor agent."),
          connection: z
            .discriminatedUnion("status", [
              z.object({
                status: z.literal("online"),
              }),
              z.object({
                status: z.literal("offline"),
              }),
            ])
            .describe("The connection status of the supervisor agent."),
        })
        .array(),
      total: z.number().describe("The total number of items."),
      page: z.number().describe("The current page number."),
      size: z.number().describe("The number of items per page."),
    }),
  });

  export const endpoint = EndpointHelpers.external
    .route({
      method: "GET",
      path: "/supervisor/list",
      description: "List all supervisor agents with pagination.",
      tags: ["Supervisor"],
    })
    .input(Input)
    .output(Output)
    .handler(async (ctx) => {
      const page = Math.floor(ctx.input.query.page);
      const size = Math.floor(ctx.input.query.size);
      const offset = (page - 1) * size;

      const db = EndpointHelpers.container.database;

      // Query supervisors that are not deleted
      const supervisors = await db.client
        .select({
          uid: db.schema.SUPERVISORS_TABLE.uid,
          name: db.schema.SUPERVISORS_TABLE.name,
          createTime: db.schema.SUPERVISORS_TABLE.createTimestamp,
          updateTime: db.schema.SUPERVISORS_TABLE.updateTimestamp,
          status: db.schema.SUPERVISORS_TABLE.status,
        })
        .from(db.schema.SUPERVISORS_TABLE)
        .where(isNull(db.schema.SUPERVISORS_TABLE.deleteTimestamp))
        .limit(size)
        .offset(offset);

      // Get total count
      const [{ total }] = await db.client
        .select({ total: count() })
        .from(db.schema.SUPERVISORS_TABLE)
        .where(isNull(db.schema.SUPERVISORS_TABLE.deleteTimestamp));

      // TODO: Check actual connection status from SupervisorRegistry
      // For now, all supervisors are marked as offline
      const data = supervisors.map((supervisor) => ({
        uid: db.uuidFromBuffer(supervisor.uid),
        name: supervisor.name,
        createTime: supervisor.createTime,
        updateTime: supervisor.updateTime,
        status: supervisor.status,
        connection: {
          status: "offline" as const,
        },
      }));

      return {
        body: {
          data,
          total,
          page,
          size,
        },
      };
    });
}
