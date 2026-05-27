import { os } from "@orpc/server";
import type { Authenticator } from "@/core/services/authenticator";

export namespace EndpointHelpers {
  export type ExternalRouterContext = {
    connectionId: string;
    credentials: Authenticator.SupervisorCredentials;
  };

  export type InternalRouterContext = {
    requestId: string;
  };

  export const internal = os
    .$route({
      inputStructure: "detailed",
      outputStructure: "detailed",
    })
    .$context<InternalRouterContext>()
    .errors({});

  export const external = os
    .$route({
      inputStructure: "detailed",
      outputStructure: "detailed",
    })
    .$context<ExternalRouterContext>()
    .errors({});
}
