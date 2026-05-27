import { z } from "zod/v4";
import { EndpointHelpers } from "@/endpoints/helpers";

export namespace SupervisorTokenList {
  export const Input = z.object({});

  export const Output = z.object({
    status: z.literal(200),
    body: z.object({
      id: z.uuid(),
      secretKey: z.string(),
    }),
  });

  export const endpoint = EndpointHelpers.external
    .route({
      method: "GET",
      path: "/supervisor/list",
      tags: ["A", "B.C"],
    })
    .input(Input)
    .output(Output)
    .handler(async () => {
      throw new Error("test");

      return {
        status: 200,
        body: {
          id: crypto.randomUUID(),
          secretKey: "",
        },
      };
    });
}
