import type { Logger } from "@aw/logging";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { GRPCHandler } from "@/api/grpc-handler";
import { ProjectResourceTier } from "@/generated/prisma/enums";
import { ProjectResourceTier as ProjectResourceTierPB } from "@/generated/proto/api/v1/project_pb";
import {
  AcknowledgeStatus,
  AssignmentSchema,
  EventAssignmentListSchema,
  EventKeepaliveSchema,
  SupervisorPortalService,
  type SupervisorPortalServiceAcknowledgeRequestValid,
  SupervisorPortalServiceAcknowledgeResponseSchema,
  type SupervisorPortalServiceReleaseRequestValid,
  SupervisorPortalServiceReleaseResponseSchema,
  type SupervisorPortalServiceWatchRequestValid,
  SupervisorPortalServiceWatchResponseSchema,
  type SupervisorPortalServiceWatchResponseValid,
} from "@/generated/proto/api/v1/supervisor-portal_pb";
import { Protobuf } from "@/helpers/protobuf";
import type { Allocator } from "@/internal/allocator";
import { Leases } from "@/internal/leases";
import type { Repository } from "@/internal/repository";

export class SupervisorPortalServiceImplementation extends GRPCHandler.ServiceImplementation {
  #logger: Logger;
  #allocator: Allocator;
  #repository: Repository;
  #supervisors: Leases;

  constructor(...deps: [Allocator, Logger, Repository, Leases]) {
    super();

    this.#allocator = deps[0];
    this.#logger = deps[1].namespace("SupervisorPortalService");
    this.#repository = deps[2];
    this.#supervisors = deps[3];
  }

  #watch(request: SupervisorPortalServiceWatchRequestValid, context: HandlerContext) {
    const supervisor = GRPCHandler.getSupervisorIdentityContextMust(context);

    let lease: Leases.Lease;

    try {
      lease = this.#supervisors.getOrCreateLease(supervisor, request.processId);
    } catch (error) {
      if (error instanceof Leases.Exception && error.code === Leases.Exception.Code.LeaseConflict) {
        throw new ConnectError(error.message, Code.AlreadyExists);
      }

      throw error;
    }

    let close: () => void;

    const stream = new ReadableStream<SupervisorPortalServiceWatchResponseValid>(
      {
        start: (ctrl) => {
          const publishListAssignmentsChanged = () => {
            this.#listAssignments(supervisor).then((list) => {
              ctrl.enqueue(
                Protobuf.createValid(SupervisorPortalServiceWatchResponseSchema, {
                  event: {
                    case: "assignmentList",
                    value: Protobuf.createValid(EventAssignmentListSchema, {
                      list,
                    }),
                  },
                }),
              );
            });
          };

          publishListAssignmentsChanged();

          const timer = setInterval(() => {
            ctrl.enqueue(
              Protobuf.createValid(SupervisorPortalServiceWatchResponseSchema, {
                event: {
                  case: "keepalive",
                  value: Protobuf.createValid(EventKeepaliveSchema, {}),
                },
              }),
            );
          }, SupervisorPortalServiceImplementation.WATCH_KEEPALIVE_INTERVAL_MS);

          const unsubscribe = lease.subscribe((event) => {
            switch (event.type) {
              case "assignment-list-changed":
                publishListAssignmentsChanged();
                break;
              case "destroyed":
                if (ctrl && ctrl.desiredSize !== null) {
                  ctrl.close();
                }
                break;
            }
          });

          close = () => {
            clearInterval(timer);
            unsubscribe();
          };
        },
        cancel() {
          close();
        },
      },
      { highWaterMark: SupervisorPortalServiceImplementation.WATCH_QUEUE_LIMIT },
    );

    return (async function* (): AsyncIterable<SupervisorPortalServiceWatchResponseValid> {
      const reader = stream.getReader();

      try {
        while (true) {
          const next = await reader.read();

          if (next.done) {
            break;
          }

          yield next.value;
        }
      } finally {
        reader.cancel();
      }
    })();
  }

  #mapResourceTierFromRepository(value: ProjectResourceTier) {
    switch (value) {
      case ProjectResourceTier.Minimum:
        return ProjectResourceTierPB.MINIMUM;
      case ProjectResourceTier.Standard:
        return ProjectResourceTierPB.STANDARD;
      case ProjectResourceTier.Performance:
        return ProjectResourceTierPB.PERFORMANCE;
      default:
        throw new Error("Unknown resource tier");
    }
  }

  async #acknowledge(request: SupervisorPortalServiceAcknowledgeRequestValid, context: HandlerContext) {
    const supervisor = GRPCHandler.getSupervisorIdentityContextMust(context);

    const instance = await this.#repository.client.instance.findFirst({
      where: {
        id: request.instanceId,
        supervisorId: supervisor,
      },
      select: {
        projectId: true,
      },
    });

    if (!instance) {
      throw new ConnectError("Instance not found.", Code.NotFound);
    }

    const pending = await this.#allocator.acknowledge(instance.projectId, request.instanceId, request.status === AcknowledgeStatus.OK);

    if (!pending) {
      throw new ConnectError("No pending allocation found for the instance.", Code.NotFound);
    }

    return Protobuf.createValid(SupervisorPortalServiceAcknowledgeResponseSchema, {});
  }

  async #release(request: SupervisorPortalServiceReleaseRequestValid, context: HandlerContext) {
    const supervisor = GRPCHandler.getSupervisorIdentityContextMust(context);

    const instance = await this.#repository.client.instance.findFirst({
      where: {
        id: request.instanceId,
        supervisorId: supervisor,
      },
      select: {
        projectId: true,
      },
    });

    if (!instance) {
      throw new ConnectError("Instance not found.", Code.NotFound);
    }

    await this.#allocator.release(instance.projectId, request.instanceId);

    return Protobuf.createValid(SupervisorPortalServiceReleaseResponseSchema, {});
  }

  async #listAssignments(supervisor: string) {
    return this.#repository.client.instance
      .findMany({
        where: {
          supervisorId: supervisor,
          project: {
            deleteTime: null,
          },
        },
        select: {
          id: true,
          confirmed: true,
          project: { select: { id: true, resourceTier: true } },
        },
      })
      .then((instances) => {
        return instances.map((instance) => {
          return Protobuf.createValid(AssignmentSchema, {
            instanceId: instance.id,
            projectId: instance.project.id,
            projectResourceTier: this.#mapResourceTierFromRepository(instance.project.resourceTier),
            confirmed: instance.confirmed,
            timestamp: Protobuf.Timestamp.now(),
          });
        });
      });
  }

  setup(router: ConnectRouter) {
    router.service(SupervisorPortalService, {
      watch: (request, context) => {
        return this.#watch(request as SupervisorPortalServiceWatchRequestValid, context);
      },
      acknowledge: async (request, context) => {
        return this.#acknowledge(request as SupervisorPortalServiceAcknowledgeRequestValid, context);
      },
      release: async (request, context) => {
        return this.#release(request as SupervisorPortalServiceReleaseRequestValid, context);
      },
    });
  }
}

export namespace SupervisorPortalServiceImplementation {
  export const WATCH_QUEUE_LIMIT = 256;
  export const WATCH_KEEPALIVE_INTERVAL_MS = 15_000;
}
