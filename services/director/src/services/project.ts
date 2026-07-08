import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { createId } from "@orama/cuid2";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { ProjectLaunchQueueStatus, ProjectResourceTier } from "@/generated/prisma/enums";
import {
  ProjectInstanceSchema,
  ProjectInstanceStatusTerminatedSchema,
  ProjectResourceTier as ProjectResourceTierPB,
  ProjectSchema,
  ProjectService,
  type ProjectServiceCreateRequestValid,
  ProjectServiceCreateResponseSchema,
  type ProjectServiceDeleteRequestValid,
  ProjectServiceDeleteResponseSchema,
  type ProjectServiceGetRequestValid,
  ProjectServiceGetResponseSchema,
  type ProjectServiceLaunchRequestValid,
  ProjectServiceLaunchResponseSchema,
  type ProjectServiceListRequestValid,
  ProjectServiceListResponseSchema,
  type ProjectServiceUpdateMetadataRequestValid,
  ProjectServiceUpdateMetadataResponseSchema,
} from "@/generated/proto/api/v1/project_pb";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { GRPCServer } from "@/internal/grpc-server";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";
import { Variables } from "@/internal/variables";

export class ProjectServiceImplementation {
  #repository: Repository;
  #server: GRPCServer;

  #variables: Variables;
  #logger: Logger;

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
        throw new Error("Unknown resource tier");
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
        throw new Error("Unknown resource tier");
    }
  }

  constructor() {
    this.#repository = Container.inject(Repository);
    this.#server = Container.inject(GRPCServer);
    this.#variables = Container.inject(Variables);
    this.#logger = Container.inject(Logger).scope("ProjectService");
  }

  async create(request: ProjectServiceCreateRequestValid, context: HandlerContext) {
    const user = this.#server.getUserIdentityContextMust(context);

    const root = this.#variables.get("AW_DIRECTOR_FS_ROOT");

    if (!root) {
      throw new ConnectError("File system root not configured.", Code.Unavailable);
    }

    const id = createId();
    const dir = join(root, "projects", id);

    if (request.templateId) {
      await this.#repository.client.template
        .findUnique({
          where: {
            id: request.templateId,
          },
        })
        .then((template) => {
          if (!template) {
            throw new ConnectError("Template not found.", Code.NotFound);
          }
        });
    }

    try {
      if (request.templateId) {
        await cp(join(root, "templates", request.templateId), dir, { recursive: true });
      } else {
        await mkdir(dir, { recursive: true });
      }

      const project = await mkdir(dir, { recursive: true }).then(() => {
        return this.#repository.transaction(async (tx) => {
          return tx.client.project.create({
            data: {
              ownerId: user,
              resourceTier: this.#mapResourceTierToRepository(request.resourceTier),
              metadata: request.metadata === undefined ? null : new Uint8Array(request.metadata),
            },
          });
        });
      });

      return Protobuf.createValid(ProjectServiceCreateResponseSchema, {
        project: Protobuf.createValid(ProjectSchema, {
          id: project.id,
          createTime: Protobuf.Timestamp.fromDate(project.createTime),
          updateTime: Protobuf.Timestamp.fromDate(project.updateTime),
          resourceTier: this.#mapResourceTierFromRepository(project.resourceTier),
          metadata: project.metadata === null ? undefined : project.metadata,
          templateId: project.templateId === null ? undefined : project.templateId,
          instance: Protobuf.createValid(ProjectInstanceSchema, {
            status: {
              case: "terminated",
              value: Protobuf.createValid(ProjectInstanceStatusTerminatedSchema, {}),
            },
          }),
        }),
      });
    } catch (error) {
      rm(dir, { recursive: true }).catch((err) => {
        this.#logger.error("Failed to rollback project directory creation", {
          directory: dir,
          err: err,
        });
      });

      throw error;
    }
  }

  async updateMetadata(request: ProjectServiceUpdateMetadataRequestValid, context: HandlerContext) {
    const user = this.#server.getUserIdentityContextMust(context);

    const project = await this.#repository.client.project
      .update({
        where: {
          id: request.id,
          ownerId: user,
          deleteTime: null,
        },
        data: {
          metadata: request.metadata === undefined ? null : new Uint8Array(request.metadata),
        },
      })
      .catch((error) => {
        if (error instanceof PrismaClientKnownRequestError && error.code === "P2025") {
          throw new ConnectError("Project not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(ProjectServiceUpdateMetadataResponseSchema, {
      project: Protobuf.createValid(ProjectSchema, {
        id: project.id,
        createTime: Protobuf.Timestamp.fromDate(project.createTime),
        updateTime: Protobuf.Timestamp.fromDate(project.updateTime),
        resourceTier: this.#mapResourceTierFromRepository(project.resourceTier),
        metadata: project.metadata === null ? undefined : project.metadata,
        templateId: project.templateId === null ? undefined : project.templateId,
        instance: Protobuf.createValid(ProjectInstanceSchema, {
          status: {
            case: "terminated",
            value: Protobuf.createValid(ProjectInstanceStatusTerminatedSchema, {}),
          },
        }),
      }),
    });
  }

  async get(request: ProjectServiceGetRequestValid, context: HandlerContext) {
    const user = this.#server.getUserIdentityContextMust(context);

    const project = await this.#repository.client.project
      .findUniqueOrThrow({
        where: {
          id: request.id,
          ownerId: user,
          deleteTime: null,
        },
      })
      .catch((error) => {
        if (error instanceof PrismaClientKnownRequestError && error.code === "P2025") {
          throw new ConnectError("Project not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(ProjectServiceGetResponseSchema, {
      project: Protobuf.createValid(ProjectSchema, {
        id: project.id,
        createTime: Protobuf.Timestamp.fromDate(project.createTime),
        updateTime: Protobuf.Timestamp.fromDate(project.updateTime),
        resourceTier: this.#mapResourceTierFromRepository(project.resourceTier),
        metadata: project.metadata === null ? undefined : project.metadata,
        templateId: project.templateId === null ? undefined : project.templateId,
        instance: Protobuf.createValid(ProjectInstanceSchema, {
          status: {
            case: "terminated",
            value: Protobuf.createValid(ProjectInstanceStatusTerminatedSchema, {}),
          },
        }),
      }),
    });
  }

  async list(request: ProjectServiceListRequestValid, context: HandlerContext) {
    const user = this.#server.getUserIdentityContextMust(context);

    const take = request.pageSize;
    const skip = (request.page - 1) * take;

    const [projects, total] = await Promise.all([
      await this.#repository.client.project.findMany({
        where: {
          deleteTime: null,
          ownerId: user,
        },
        orderBy: {
          createTime: "desc",
        },
        take,
        skip,
      }),

      await this.#repository.client.project.count({
        where: {
          deleteTime: null,
          ownerId: user,
        },
      }),
    ]);

    return Protobuf.createValid(ProjectServiceListResponseSchema, {
      projects: projects.map((project) => {
        return Protobuf.createValid(ProjectSchema, {
          id: project.id,
          createTime: Protobuf.Timestamp.fromDate(project.createTime),
          updateTime: Protobuf.Timestamp.fromDate(project.updateTime),
          resourceTier: this.#mapResourceTierFromRepository(project.resourceTier),
          metadata: project.metadata === null ? undefined : project.metadata,
          templateId: project.templateId === null ? undefined : project.templateId,
          instance: Protobuf.createValid(ProjectInstanceSchema, {
            status: {
              case: "terminated",
              value: Protobuf.createValid(ProjectInstanceStatusTerminatedSchema, {}),
            },
          }),
        });
      }),
      total,
    });
  }

  async delete(request: ProjectServiceDeleteRequestValid, context: HandlerContext) {
    const user = this.#server.getUserIdentityContextMust(context);

    const project = await this.#repository.client.project
      .update({
        where: {
          id: request.id,
          ownerId: user,
          deleteTime: null,
        },
        data: {
          deleteTime: new Date(),
        },
      })
      .catch((error) => {
        if (error instanceof PrismaClientKnownRequestError && error.code === "P2025") {
          throw new ConnectError("Project not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(ProjectServiceDeleteResponseSchema, {
      project: Protobuf.createValid(ProjectSchema, {
        id: project.id,
        createTime: Protobuf.Timestamp.fromDate(project.createTime),
        updateTime: Protobuf.Timestamp.fromDate(project.updateTime),
        resourceTier: this.#mapResourceTierFromRepository(project.resourceTier),
        metadata: project.metadata === null ? undefined : project.metadata,
        templateId: project.templateId === null ? undefined : project.templateId,
        instance: Protobuf.createValid(ProjectInstanceSchema, {
          status: {
            case: "terminated",
            value: Protobuf.createValid(ProjectInstanceStatusTerminatedSchema, {}),
          },
        }),
      }),
    });
  }

  async launch(request: ProjectServiceLaunchRequestValid, context: HandlerContext) {
    const user = this.#server.getUserIdentityContextMust(context);

    const project = await this.#repository.client.project.findUnique({
      where: {
        id: request.id,
        ownerId: user,
        deleteTime: null,
      },
    });

    if (!project) {
      throw new ConnectError("Project not found", Code.NotFound);
    }

    await this.#repository.transaction(async (tx) => {
      await tx.client.$queryRaw`SELECT 1 FROM \`project\` WHERE \`id\` = ${project.id} FOR UPDATE`;

      const activeLaunch = await tx.client.projectLaunchQueue.findFirst({
        where: {
          projectId: project.id,
          status: {
            not: ProjectLaunchQueueStatus.Terminated,
          },
        },
      });

      if (activeLaunch) {
        throw new ConnectError("Project already has an active launch", Code.FailedPrecondition);
      }

      await tx.client.projectLaunchQueue.create({
        data: {
          projectId: project.id,
          status: ProjectLaunchQueueStatus.Pending,
        },
      });
    });

    return Protobuf.createValid(ProjectServiceLaunchResponseSchema, {});
  }

  setup(router: ConnectRouter) {
    router.service(ProjectService, {
      create: async (request, context) => {
        return this.create(request as ProjectServiceCreateRequestValid, context);
      },
      updateMetadata: async (request, context) => {
        return this.updateMetadata(request as ProjectServiceUpdateMetadataRequestValid, context);
      },
      list: async (request, context) => {
        return this.list(request as ProjectServiceListRequestValid, context);
      },
      delete: async (request, context) => {
        return this.delete(request as ProjectServiceDeleteRequestValid, context);
      },
      get: async (request, context) => {
        return this.get(request as ProjectServiceGetRequestValid, context);
      },
      launch: async (request, context) => {
        return this.launch(request as ProjectServiceLaunchRequestValid, context);
      },
    });
  }
}
