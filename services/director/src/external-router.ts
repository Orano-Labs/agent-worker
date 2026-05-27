import { EndpointHelpers } from "@/endpoints/helpers";
import { SupervisorTokenDelete } from "@/endpoints/supervisor/token/delete";
import { SupervisorTokenGenerate } from "@/endpoints/supervisor/token/generate";
import { SupervisorTokenList } from "@/endpoints/supervisor/token/list";

export const EXTERNAL_ROUTER = EndpointHelpers.external.prefix("/api/v1").router({
  supervisors: {
    tokens: {
      generate: SupervisorTokenGenerate.endpoint,
      delete: SupervisorTokenDelete.endpoint,
      list: SupervisorTokenList.endpoint,
    },
  },
  keys: {},
  templates: {},
  issues: {},
  tasks: {},
  analytics: {},
});
