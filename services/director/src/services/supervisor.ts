import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
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
  type SupervisorServiceUpdateNameRequestValid,
  SupervisorServiceUpdateNameResponseSchema,
} from "@/generated/proto/api/v1/supervisor_pb";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { Key } from "@/internal/key";
import { Repository } from "@/internal/repository";

export class SupervisorServiceImplementation {
  #repository: Repository;
  #key: Key;

  constructor() {
    this.#repository = Container.inject(Repository);
    this.#key = Container.inject(Key);
  }

  async create(request: SupervisorServiceCreateRequestValid, _: HandlerContext) {
    const keys = await this.#key.generateED25519();

    const supervisor = await this.#repository.client.supervisor.create({
      data: {
        publicKey: Uint8Array.from(keys[0]),
        metadata: request.metadata ? Uint8Array.from(request.metadata) : null,
        name: request.name,
      },
    });

    return Protobuf.createValid(SupervisorServiceCreateResponseSchema, {
      supervisor: Protobuf.createValid(SupervisorSchema, {
        id: supervisor.id,
        publicKey: supervisor.publicKey,
        createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
        updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
        name: supervisor.name,
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
        publicKey: supervisor.publicKey,
        createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
        updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
        name: supervisor.name,
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
        publicKey: supervisor.publicKey,
        createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
        updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
        name: supervisor.name,
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
        publicKey: supervisor.publicKey,
        createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
        updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
        name: supervisor.name,
        metadata: supervisor.metadata === null ? undefined : supervisor.metadata,
      }),
    });
  }

  async updateName(request: SupervisorServiceUpdateNameRequestValid, _: HandlerContext) {
    const supervisor = await this.#repository.client.supervisor
      .update({
        where: {
          id: request.id,
          deleteTime: null,
        },
        data: {
          name: request.name,
        },
      })
      .catch((error) => {
        if (error instanceof PrismaClientKnownRequestError && error.code === "P2025") {
          throw new ConnectError("Supervisor not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(SupervisorServiceUpdateNameResponseSchema, {
      supervisor: Protobuf.createValid(SupervisorSchema, {
        id: supervisor.id,
        publicKey: supervisor.publicKey,
        createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
        updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
        name: supervisor.name,
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
          publicKey: supervisor.publicKey,
          createTime: Protobuf.Timestamp.fromDate(supervisor.createTime),
          updateTime: Protobuf.Timestamp.fromDate(supervisor.updateTime),
          name: supervisor.name,
          metadata: supervisor.metadata === null ? undefined : supervisor.metadata,
        }),
      ),
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
      updateName: async (request, context) => {
        return this.updateName(request as SupervisorServiceUpdateNameRequestValid, context);
      },
    });
  }
}
