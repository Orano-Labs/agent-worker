import { default as createClient } from "openapi-fetch";

import type { $defs, components, operations, paths, webhooks } from "@/supports/git/openapi.v1";

export namespace GitAPI {
  export const create = (options: Parameters<typeof createClient>[0]) => {
    return createClient<Paths>(options);
  };

  export type Paths = paths;
  export type Components = components;
  export type Operations = operations;
  export type Defs = $defs;
  export type Webhooks = webhooks;

  export type Client = ReturnType<typeof create>;
}
