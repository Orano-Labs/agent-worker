import { EndpointHelpers } from "@/endpoints/helpers";
import { SupervisorCreate } from "@/endpoints/supervisor/create";
import { SupervisorDelete } from "@/endpoints/supervisor/delete";
import { SupervisorList } from "@/endpoints/supervisor/list";

export const EXTERNAL_ROUTER = EndpointHelpers.external.prefix("/api/v1").router({
  supervisors: {
    create: SupervisorCreate.endpoint,
    list: SupervisorList.endpoint,
    delete: SupervisorDelete.endpoint,
  },
});
