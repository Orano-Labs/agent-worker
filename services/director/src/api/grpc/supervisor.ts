import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { GRPCHandler } from "@/api/grpc-handler";
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
  type SupervisorServiceUpdateMetadataRequestValid,
  SupervisorServiceUpdateMetadataResponseSchema,
} from "@/generated/proto/api/v1/supervisor_pb";
import { Protobuf } from "@/helpers/protobuf";
import type { Allocator } from "@/internal/allocator";
import type { Key } from "@/internal/key";
import type { Repository } from "@/internal/repository";

export class SupervisorServiceImplementation extends GRPCHandler.ServiceImplementation {
  #repository: Repository;
  #key: Key;
  #allocator: Allocator;

  constructor(...deps: [Repository, Key, Allocator]) {
    super();

    this.#repository = deps[0];
    this.#key = deps[1];
    this.#allocator = deps[2];
  }

  async #create(request: SupervisorServiceCreateRequestValid, _: HandlerContext) {
    const keys = await this.#key.generateED25519();

    const supervisor = await this.#repository.client.supervisor.create({
      data: {
        publicKey: Uint8Array.from(keys[0]),
        metadata: request.metadata ? Uint8Array.from(request.metadata) : null,
        capacity: request.capacity,
        remainingCapacity: request.capacity,
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
        capacity: supervisor.capacity,
      }),
      privateKey: keys[1],
    });
  }

  async #get(request: SupervisorServiceGetRequestValid, _: HandlerContext) {
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
        online: !!this.#allocator.getLease(supervisor.id),
        publicKey: supervisor.publicKey,
        createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
        updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
        metadata: supervisor.metadata === null ? undefined : supervisor.metadata,
        capacity: supervisor.capacity,
      }),
    });
  }

  async #delete(request: SupervisorServiceDeleteRequestValid, _: HandlerContext) {
    if (this.#allocator.getLease(request.id)) {
      throw new ConnectError("Cannot delete a supervisor that is currently online.", Code.FailedPrecondition);
    }

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
        online: !!this.#allocator.getLease(supervisor.id),
        publicKey: supervisor.publicKey,
        createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
        updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
        metadata: supervisor.metadata === null ? undefined : supervisor.metadata,
        capacity: supervisor.capacity,
      }),
    });
  }

  async #updateMetadata(request: SupervisorServiceUpdateMetadataRequestValid, _: HandlerContext) {
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
        online: !!this.#allocator.getLease(supervisor.id),
        publicKey: supervisor.publicKey,
        createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
        updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
        metadata: supervisor.metadata === null ? undefined : supervisor.metadata,
        capacity: supervisor.capacity,
      }),
    });
  }

  async #list(request: SupervisorServiceListRequestValid, _: HandlerContext) {
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
          online: !!this.#allocator.getLease(supervisor.id),
          publicKey: supervisor.publicKey,
          createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
          updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
          metadata: supervisor.metadata === null ? undefined : supervisor.metadata,
          capacity: supervisor.capacity,
        }),
      ),
    });
  }

  setup(router: ConnectRouter) {
    router.service(SupervisorService, {
      create: async (request, context) => {
        return this.#create(request as SupervisorServiceCreateRequestValid, context);
      },
      get: async (request, context) => {
        return this.#get(request as SupervisorServiceGetRequestValid, context);
      },
      delete: async (request, context) => {
        return this.#delete(request as SupervisorServiceDeleteRequestValid, context);
      },
      updateMetadata: async (request, context) => {
        return this.#updateMetadata(request as SupervisorServiceUpdateMetadataRequestValid, context);
      },
      list: async (request, context) => {
        return this.#list(request as SupervisorServiceListRequestValid, context);
      },
    });
  }
}
