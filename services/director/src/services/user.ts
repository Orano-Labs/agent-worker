import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import {
  UserSchema,
  UserService,
  type UserServiceCreateRequestValid,
  UserServiceCreateResponseSchema,
  type UserServiceDeleteRequestValid,
  UserServiceDeleteResponseSchema,
  type UserServiceDisableRequestValid,
  UserServiceDisableResponseSchema,
  type UserServiceEnableRequestValid,
  UserServiceEnableResponseSchema,
  type UserServiceGetRequestValid,
  UserServiceGetResponseSchema,
  type UserServiceListRequestValid,
  UserServiceListResponseSchema,
  type UserServiceUpdateMetadataRequestValid,
  UserServiceUpdateMetadataResponseSchema,
} from "@/generated/proto/api/v1/user_pb";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { Key } from "@/internal/key";
import { Repository } from "@/internal/repository";

export class UserServiceImplementation {
  #repository: Repository;
  #key: Key;

  constructor() {
    this.#repository = Container.inject(Repository);
    this.#key = Container.inject(Key);
  }

  async create(request: UserServiceCreateRequestValid, _: HandlerContext) {
    const keys = await this.#key.generateED25519();

    const user = await this.#repository.client.user.create({
      data: {
        publicKey: Uint8Array.from(keys[0]),
        metadata: request.metadata ? Uint8Array.from(request.metadata) : null,
        disabled: request.disabled,
      },
    });

    return Protobuf.createValid(UserServiceCreateResponseSchema, {
      user: Protobuf.createValid(UserSchema, {
        id: user.id,
        publicKey: user.publicKey,
        disabled: user.disabled,
        createTime: Protobuf.Timestamp.fromDate(user.createTime),
        updateTime: Protobuf.Timestamp.fromDate(user.updateTime),
      }),
      privateKey: keys[1],
    });
  }

  async get(request: UserServiceGetRequestValid, _: HandlerContext) {
    const user = await this.#repository.client.user.findUnique({
      where: {
        id: request.id,
        deleteTime: null,
      },
    });

    if (!user) {
      throw new ConnectError("User not found.", Code.NotFound);
    }

    return Protobuf.createValid(UserServiceGetResponseSchema, {
      user: Protobuf.createValid(UserSchema, {
        id: user.id,
        publicKey: user.publicKey,
        disabled: user.disabled,
        createTime: Protobuf.Timestamp.fromDate(user.createTime),
        updateTime: Protobuf.Timestamp.fromDate(user.updateTime),
      }),
    });
  }

  async enable(request: UserServiceEnableRequestValid, _: HandlerContext) {
    const user = await this.#repository.client.user
      .update({
        where: {
          id: request.id,
          deleteTime: null,
        },
        data: {
          disabled: false,
        },
      })
      .catch((error) => {
        if (error instanceof PrismaClientKnownRequestError && error.code === "P2025") {
          throw new ConnectError("User not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(UserServiceEnableResponseSchema, {
      user: Protobuf.createValid(UserSchema, {
        id: user.id,
        publicKey: user.publicKey,
        disabled: user.disabled,
        createTime: Protobuf.Timestamp.fromDate(user.createTime),
        updateTime: Protobuf.Timestamp.fromDate(user.updateTime),
      }),
    });
  }

  async disable(request: UserServiceDisableRequestValid, _: HandlerContext) {
    const user = await this.#repository.client.user
      .update({
        where: {
          id: request.id,
          deleteTime: null,
        },
        data: {
          disabled: true,
        },
      })
      .catch((error) => {
        if (error instanceof PrismaClientKnownRequestError && error.code === "P2025") {
          throw new ConnectError("User not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(UserServiceDisableResponseSchema, {
      user: Protobuf.createValid(UserSchema, {
        id: user.id,
        publicKey: user.publicKey,
        disabled: user.disabled,
        createTime: Protobuf.Timestamp.fromDate(user.createTime),
        updateTime: Protobuf.Timestamp.fromDate(user.updateTime),
      }),
    });
  }

  async delete(request: UserServiceDeleteRequestValid, _: HandlerContext) {
    const user = await this.#repository.client.user
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
          throw new ConnectError("User not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(UserServiceDeleteResponseSchema, {
      user: Protobuf.createValid(UserSchema, {
        id: user.id,
        publicKey: user.publicKey,
        disabled: user.disabled,
        createTime: Protobuf.Timestamp.fromDate(user.createTime),
        updateTime: Protobuf.Timestamp.fromDate(user.updateTime),
      }),
    });
  }

  async updateMetadata(request: UserServiceUpdateMetadataRequestValid, _: HandlerContext) {
    const user = await this.#repository.client.user
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
          throw new ConnectError("User not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(UserServiceUpdateMetadataResponseSchema, {
      user: Protobuf.createValid(UserSchema, {
        id: user.id,
        publicKey: user.publicKey,
        disabled: user.disabled,
        createTime: Protobuf.Timestamp.fromDate(user.createTime),
        updateTime: Protobuf.Timestamp.fromDate(user.updateTime),
      }),
    });
  }

  async list(request: UserServiceListRequestValid, _: HandlerContext) {
    const take = request.pageSize;
    const skip = (request.page - 1) * take;

    const [users, total] = await Promise.all([
      await this.#repository.client.user.findMany({
        where: {
          deleteTime: null,
        },
        orderBy: {
          createTime: "desc",
        },
        take,
        skip,
      }),

      await this.#repository.client.user.count({
        where: {
          deleteTime: null,
        },
      }),
    ]);

    return Protobuf.createValid(UserServiceListResponseSchema, {
      total,
      users: users.map((user) =>
        Protobuf.createValid(UserSchema, {
          id: user.id,
          publicKey: user.publicKey,
          disabled: user.disabled,
          createTime: Protobuf.Timestamp.fromDate(user.createTime),
          updateTime: Protobuf.Timestamp.fromDate(user.updateTime),
        }),
      ),
    });
  }

  setup(router: ConnectRouter) {
    router.service(UserService, {
      create: async (request, context) => {
        return this.create(request as UserServiceCreateRequestValid, context);
      },
      get: async (request, context) => {
        return this.get(request as UserServiceGetRequestValid, context);
      },
      enable: async (request, context) => {
        return this.enable(request as UserServiceEnableRequestValid, context);
      },
      disable: async (request, context) => {
        return this.disable(request as UserServiceDisableRequestValid, context);
      },
      delete: async (request, context) => {
        return this.delete(request as UserServiceDeleteRequestValid, context);
      },
      updateMetadata: async (request, context) => {
        return this.updateMetadata(request as UserServiceUpdateMetadataRequestValid, context);
      },
      list: async (request, context) => {
        return this.list(request as UserServiceListRequestValid, context);
      },
    });
  }
}
