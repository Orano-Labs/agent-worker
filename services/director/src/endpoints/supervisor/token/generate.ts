import { z } from "zod/v4";
import { EndpointHelpers } from "@/endpoints/helpers";

export namespace SupervisorTokenGenerate {
  export const Input = z.object({
    body: z.object({}),
  });

  export const Output = z.object({
    status: z.literal(200),
    body: z.object({
      id: z.uuid(),
      secretKey: z.string(),
    }),
  });

  export const endpoint = EndpointHelpers.external
    .route({
      method: "POST",
      path: "/supervisor/tokens",
    })
    .input(Input)
    .output(Output)
    .handler(async () => {
      return {
        status: 200,
        body: {
          id: "",
          secretKey: "",
        },
      };
    });
}
