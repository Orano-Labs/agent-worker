import { ORPCError } from "@orpc/server";
import { z } from "zod/v4";
import { EndpointHelpers } from "@/endpoints/helpers";

export namespace SupervisorCreate {
  export const Input = z.object({
    params: z.object({
      id: z.uuid(),
    }),
  });

  export const Output = z.object({
    body: z.object({
      id: z.uuid(),
      privateKey: z.string(),
    }),
  });

  export const endpoint = EndpointHelpers.external
    .route({
      method: "POST",
      path: "/supervisor",
    })
    .input(Input)
    .output(Output)
    .handler(async (ctx) => {
      return {
        body: {
          id: "",
          privateKey: "",
        },
      };
    });
}
