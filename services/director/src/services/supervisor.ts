import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { SupervisorRegistry } from "@/core/supervisor-registry";
import {
  SupervisorSchema,
  SupervisorService,
  type SupervisorServiceCreateRequestValid,
  SupervisorServiceCreateResponseSchema,
  type SupervisorServiceDeleteRequestValid,
  SupervisorServiceDeleteResponseSchema,
  type SupervisorServiceGetRequestValid,
  SupervisorServiceGetResponseSchema,
  type SupervisorServiceListRequestValid,
  SupervisorServiceListResponseSchema,
  type SupervisorServiceStatusRequestValid,
  SupervisorServiceStatusResponseSchema,
  type SupervisorServiceUpdateMetadataRequestValid,
  SupervisorServiceUpdateMetadataResponseSchema,
  SupervisorStatusNeverOnlineSchema,
  SupervisorStatusOfflineSchema,
  SupervisorStatusOnlineSchema,
  SupervisorStatusSchema,
} from "@/generated/proto/api/v1/supervisor_pb";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { Key } from "@/internal/key";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";

export class SupervisorServiceImplementation {
  #repository: Repository;
  #key: Key;
  #registry: SupervisorRegistry;
  #logger: Logger;

  constructor() {
    this.#repository = Container.inject(Repository);
    this.#key = Container.inject(Key);
    this.#registry = Container.inject(SupervisorRegistry);
    this.#logger = Container.inject(Logger).scope("SupervisorService");
  }

  async create(request: SupervisorServiceCreateRequestValid, _: HandlerContext) {
    const keys = await this.#key.generateED25519();

    const supervisor = await this.#repository.client.supervisor.create({
      data: {
        publicKey: Uint8Array.from(keys[0]),
        metadata: request.metadata ? Uint8Array.from(request.metadata) : null,
      },
    });

    return Protobuf.createValid(SupervisorServiceCreateResponseSchema, {
      supervisor: Protobuf.createValid(SupervisorSchema, {
        id: supervisor.id,
        online: false,
        publicKey: supervisor.publicKey,
        createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
        updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
        metadata: supervisor.metadata === null ? undefined : supervisor.metadata,
      }),
      privateKey: keys[1],
    });
  }

  async get(request: SupervisorServiceGetRequestValid, _: HandlerContext) {
    const supervisor = await this.#repository.client.supervisor.findUnique({
      where: {
        id: request.id,
        deleteTime: null,
      },
    });

    if (!supervisor) {
      throw new ConnectError("Supervisor not found.", Code.NotFound);
    }

    return Protobuf.createValid(SupervisorServiceGetResponseSchema, {
      supervisor: Protobuf.createValid(SupervisorSchema, {
        id: supervisor.id,
        online: this.#registry.isOnline(supervisor.id),
        publicKey: supervisor.publicKey,
        createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
        updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
        metadata: supervisor.metadata === null ? undefined : supervisor.metadata,
      }),
    });
  }

  async delete(request: SupervisorServiceDeleteRequestValid, _: HandlerContext) {
    const supervisor = await this.#repository.client.supervisor
      .update({
        where: {
          id: request.id,
          deleteTime: null,
        },
        data: {
          deleteTime: new Date(),
        },
      })
      .catch((error) => {
        if (error instanceof PrismaClientKnownRequestError && error.code === "P2025") {
          throw new ConnectError("Supervisor not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(SupervisorServiceDeleteResponseSchema, {
      supervisor: Protobuf.createValid(SupervisorSchema, {
        id: supervisor.id,
        online: this.#registry.isOnline(supervisor.id),
        publicKey: supervisor.publicKey,
        createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
        updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
        metadata: supervisor.metadata === null ? undefined : supervisor.metadata,
      }),
    });
  }

  async updateMetadata(request: SupervisorServiceUpdateMetadataRequestValid, _: HandlerContext) {
    const supervisor = await this.#repository.client.supervisor
      .update({
        where: {
          id: request.id,
          deleteTime: null,
        },
        data: {
          metadata: request.metadata ? Uint8Array.from(request.metadata) : null,
        },
      })
      .catch((error) => {
        if (error instanceof PrismaClientKnownRequestError && error.code === "P2025") {
          throw new ConnectError("Supervisor not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(SupervisorServiceUpdateMetadataResponseSchema, {
      supervisor: Protobuf.createValid(SupervisorSchema, {
        id: supervisor.id,
        online: this.#registry.isOnline(supervisor.id),
        publicKey: supervisor.publicKey,
        createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
        updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
        metadata: supervisor.metadata === null ? undefined : supervisor.metadata,
      }),
    });
  }

  async list(request: SupervisorServiceListRequestValid, _: HandlerContext) {
    const take = request.pageSize;
    const skip = (request.page - 1) * take;

    const [supervisors, total] = await Promise.all([
      await this.#repository.client.supervisor.findMany({
        where: {
          deleteTime: null,
        },
        orderBy: {
          createTime: "desc",
        },
        take,
        skip,
      }),

      await this.#repository.client.supervisor.count({
        where: {
          deleteTime: null,
        },
      }),
    ]);

    return Protobuf.createValid(SupervisorServiceListResponseSchema, {
      total,
      supervisors: supervisors.map((supervisor) =>
        Protobuf.createValid(SupervisorSchema, {
          id: supervisor.id,
          online: this.#registry.isOnline(supervisor.id),
          publicKey: supervisor.publicKey,
          createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
          updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
          metadata: supervisor.metadata === null ? undefined : supervisor.metadata,
        }),
      ),
    });
  }

  /**
   * Query the real-time status of a Supervisor.
   *
   * The status is sourced from {@link SupervisorRegistry}, which is kept up-to-date
   * by periodic reports flowing through the SupervisorPortal's Report RPC.
   *
   * If the Supervisor has never reported, its existence is verified against the
   * database and an offline status with no metrics or timestamps is returned.
   */
  async status(request: SupervisorServiceStatusRequestValid, _: HandlerContext) {
    // Not in SupervisorRegistry — may have never come online. Verify against DB.
    const exists = await this.#repository.client.supervisor.findUnique({
      where: { id: request.id, deleteTime: null },
      select: { id: true },
    });

    if (!exists) {
      throw new ConnectError("Supervisor not found.", Code.NotFound);
    }

    const snapshot = await this.#registry.get(request.id);

    if (snapshot) {
      const { state } = snapshot;

      if (state.type === "online") {
        return Protobuf.createValid(SupervisorServiceStatusResponseSchema, {
          status: Protobuf.createValid(SupervisorStatusSchema, {
            id: request.id,
            status: {
              case: "online",
              value: Protobuf.createValid(SupervisorStatusOnlineSchema, {
                runningProjects: state.metrics.runningProjects,
                cpuUsage: state.metrics.cpuUsage,
                memoryUsage: state.metrics.memoryUsage,
                diskUsage: state.metrics.diskUsage,
              }),
            },
          }),
        });
      }

      return Protobuf.createValid(SupervisorServiceStatusResponseSchema, {
        status: Protobuf.createValid(SupervisorStatusSchema, {
          id: request.id,
          status: {
            case: "offline",
            value: Protobuf.createValid(SupervisorStatusOfflineSchema, {
              lastOnlineAt: Protobuf.Timestamp.fromDate(state.lastOnlineAt),
              lastReportAt: Protobuf.Timestamp.fromDate(snapshot.lastReportAt),
            }),
          },
        }),
      });
    }

    return Protobuf.createValid(SupervisorServiceStatusResponseSchema, {
      status: Protobuf.createValid(SupervisorStatusSchema, {
        id: request.id,
        status: {
          case: "neverOnline",
          value: Protobuf.createValid(SupervisorStatusNeverOnlineSchema, {}),
        },
      }),
    });
  }

  setup(router: ConnectRouter) {
    router.service(SupervisorService, {
      create: async (request, context) => {
        return this.create(request as SupervisorServiceCreateRequestValid, context);
      },
      get: async (request, context) => {
        return this.get(request as SupervisorServiceGetRequestValid, context);
      },
      delete: async (request, context) => {
        return this.delete(request as SupervisorServiceDeleteRequestValid, context);
      },
      updateMetadata: async (request, context) => {
        return this.updateMetadata(request as SupervisorServiceUpdateMetadataRequestValid, context);
      },
      list: async (request, context) => {
        return this.list(request as SupervisorServiceListRequestValid, context);
      },
      status: async (request, context) => {
        return this.status(request as SupervisorServiceStatusRequestValid, context);
      },
    });
  }
}
