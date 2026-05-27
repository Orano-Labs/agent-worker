import { EndpointHelpers } from "@/endpoints/helpers";
import { SupervisorTokenDelete } from "@/endpoints/supervisor/token/delete";
import { SupervisorTokenGenerate } from "@/endpoints/supervisor/token/generate";
import { SupervisorTokenList } from "@/endpoints/supervisor/token/list";

export const INTERNAL_ROUTER = EndpointHelpers.internal.router({
  supervisors: {},
});
