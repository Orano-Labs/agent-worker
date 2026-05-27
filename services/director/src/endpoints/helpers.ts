import { os } from "@orpc/server";
import { Authenticator } from "@/core/services/authenticator";
import { Container } from "@/helpers/container";
import { Database } from "@/internal/database";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

export namespace EndpointHelpers {
  export type ExternalRouterContext = {
    requestId: string;
  };

  export type InternalRouterContext = {
    connectionId: string;
    credentials: Authenticator.SupervisorCredentials;
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

  export const container = {
    get logger() {
      return Container.inject(Logger);
    },
    get variables() {
      return Container.inject(Variables);
    },
    get database() {
      return Container.inject(Database);
    },
    get authenticator() {
      return Container.inject(Authenticator);
    },
  };
}
