import type { ConnectRouter, HandlerContext } from "@connectrpc/connect";
import { ProjectResourceTier } from "@/generated/prisma/enums";
import {
  ProjectDeploymentPendingSchema,
  ProjectResourceTier as ProjectResourceTierPB,
  ProjectSchema,
  ProjectService,
  type ProjectServiceCreateRequestValid,
  ProjectServiceCreateResponseSchema,
} from "@/generated/proto/api/v1/project_pb";
import { EventProjectCreatedSchema } from "@/generated/proto/event/v1/project_pb";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { GRPCServer } from "@/internal/grpc-server";
import { MessageBroker } from "@/internal/message-broker";
import { MessageOutbox } from "@/internal/message-outbox";
import { Repository } from "@/internal/repository";

const ON_PROJECT_CREATED = MessageBroker.register("project/HandleProjectCreated", [EventProjectCreatedSchema]);

export class ProjectServiceImplementation {
  #repository: Repository;
  #server: GRPCServer;
  #outbox: MessageOutbox;

  #mapResourceTierToRepository(value: ProjectResourceTierPB) {
    switch (value) {
      case ProjectResourceTierPB.UNSPECIFIED:
      case ProjectResourceTierPB.MINIMUM:
        return ProjectResourceTier.Minimum;
      case ProjectResourceTierPB.STANDARD:
        return ProjectResourceTier.Standard;
      case ProjectResourceTierPB.PERFORMANCE:
        return ProjectResourceTier.Performance;
      default:
        throw new Error("");
    }
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
        throw new Error("");
    }
  }

  constructor() {
    this.#repository = Container.inject(Repository);
    this.#server = Container.inject(GRPCServer);
    this.#outbox = Container.inject(MessageOutbox);
  }

  async create(request: ProjectServiceCreateRequestValid, context: HandlerContext) {
    const user = this.#server.getUserIdentityContextMust(context);

    const project = await this.#repository.transaction(async (tx) => {
      const project = await tx.client.project.create({
        data: {
          name: request.name,
          description: request.description,
          ownerId: user,
          resourceTier: this.#mapResourceTierToRepository(request.resourceTier),
        },
      });

      const envelopPayload = Protobuf.createValid(EventProjectCreatedSchema, {
        id: project.id,
      });
      const envelop = MessageOutbox.envelope(EventProjectCreatedSchema, envelopPayload);

      await this.#outbox.write(envelop, tx);

      return project;
    });

    return Protobuf.createValid(ProjectServiceCreateResponseSchema, {
      project: Protobuf.createValid(ProjectSchema, {
        id: project.id,
        createTime: Protobuf.Timestamp.fromDate(project.createTime),
        updateTime: Protobuf.Timestamp.fromDate(project.updateTime),
        name: project.name,
        description: project.description === null ? undefined : request.description,
        resourceTier: this.#mapResourceTierFromRepository(project.resourceTier),
        deployment: {
          value: Protobuf.createValid(ProjectDeploymentPendingSchema, {
            processing: false,
          }),
          case: "pending",
        },
      }),
    });
  }

  setup(router: ConnectRouter) {
    router.service(ProjectService, {
      create: async (request, context) => {
        return this.create(request as ProjectServiceCreateRequestValid, context);
      },
    });
  }

  async init() {
    await ON_PROJECT_CREATED.value.subscribe({}, async (envelope) => {
      // TODO: xxx
    });
  }
}
