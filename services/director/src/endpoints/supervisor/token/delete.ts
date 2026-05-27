import { ORPCError } from "@orpc/server";
import { z } from "zod/v4";
import { EndpointHelpers } from "@/endpoints/helpers";

export namespace SupervisorTokenDelete {
  export const Input = z.object({
    params: z.object({
      id: z.uuid(),
    }),
  });

  export const Output = z.object({
    body: z.object({
      id: z.uuid(),
      secretKey: z.string(),
    }),
  });

  export const endpoint = EndpointHelpers.external
    .route({
      method: "DELETE",
      path: "/supervisor/tokens/{id}",
    })
    .input(Input)
    .output(Output)
    .handler(async (ctx) => {
      return {
        body: {
          id: "",
          secretKey: "",
        },
      };
    });
}
