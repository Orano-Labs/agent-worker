import { Logger } from "@aw/logging";
import { Base } from "@/api/grpc/base";
import {
  UserService,
  UserServiceCreateRequest,
  UserServiceCreateResponse,
  UserServiceDeleteRequest,
  UserServiceDeleteResponse,
  UserServiceDisableRequest,
  UserServiceDisableResponse,
  UserServiceEnableRequest,
  UserServiceEnableResponse,
  UserServiceGetRequest,
  UserServiceGetResponse,
  UserServiceListRequest,
  UserServiceListResponse,
  UserServiceUpdateMetadataRequest,
  UserServiceUpdateMetadataResponse,
} from "@/generated/proto/api/v1/user";
import { Authenticator } from "@/internal/authenticator";
import { GRPCHandler } from "@/internal/grpc-handler";
import { Users } from "@/internal/users";

export class UserServiceImpl extends Base implements UserService<GRPCHandler.Context> {
  #authenticator: Authenticator;
  #users: Users;

  constructor(...deps: [Authenticator, Users, Logger]) {
    const logger = deps[2].namespace("GRPC.UserServiceImpl");

    super(deps[0], logger);

    this.#authenticator = deps[0];
    this.#users = deps[1];
  }

  async create(request: UserServiceCreateRequest, _: GRPCHandler.Context): Promise<UserServiceCreateResponse> {
    const [publicKey, privateKey] = await this.#authenticator.generateKeyPair();

    const user = await this.#users.create({
      publicKey,
      metadata: request.metadata ?? null,
      disabled: request.disabled ?? false,
    });

    return {
      user: this.#toUser(user),
      privateKey,
    };
  }

  async get(request: UserServiceGetRequest, _: GRPCHandler.Context): Promise<UserServiceGetResponse> {
    const user = await this.#users.get(request.id);

    if (!user) {
      throw GRPCHandler.Error.notFound("User not found.");
    }

    return {
      user: this.#toUser(user),
    };
  }

  async list(request: UserServiceListRequest, _: GRPCHandler.Context): Promise<UserServiceListResponse> {
    const result = await this.#users.list({
      page: request.page,
      pageSize: request.pageSize,
      disabled: request.disabled,
    });

    return {
      users: result.users.map((user) => this.#toUser(user)),
      total: result.total,
    };
  }

  async updateMetadata(request: UserServiceUpdateMetadataRequest, _: GRPCHandler.Context): Promise<UserServiceUpdateMetadataResponse> {
    const user = await this.#users.update(request.id, {
      metadata: request.metadata ?? null,
    });

    if (!user) {
      throw GRPCHandler.Error.notFound("User not found.");
    }

    return {
      user: this.#toUser(user),
    };
  }

  async delete(request: UserServiceDeleteRequest, _: GRPCHandler.Context): Promise<UserServiceDeleteResponse> {
    const deleted = await this.#users.delete(request.id);

    if (!deleted) {
      throw GRPCHandler.Error.notFound("User not found.");
    }

    return {};
  }

  async enable(request: UserServiceEnableRequest, _: GRPCHandler.Context): Promise<UserServiceEnableResponse> {
    const user = await this.#users.update(request.id, { disabled: false });

    if (!user) {
      throw GRPCHandler.Error.notFound("User not found.");
    }

    return {
      user: this.#toUser(user),
    };
  }

  async disable(request: UserServiceDisableRequest, _: GRPCHandler.Context): Promise<UserServiceDisableResponse> {
    const user = await this.#users.update(request.id, { disabled: true });

    if (!user) {
      throw GRPCHandler.Error.notFound("User not found.");
    }

    return {
      user: this.#toUser(user),
    };
  }

  #toUser(user: Users.User) {
    return {
      id: user.id,
      publicKey: user.publicKey,
      metadata: user.metadata ?? undefined,
      disabled: user.disabled,
      createTime: user.createTime,
      updateTime: user.updateTime,
    };
  }

  setup(register: (route: GRPCHandler.Route) => void): void {
    const interceptors = [this.createAuthenticationInterceptor(), this.createAccessControlInterceptor("manager")];

    register(GRPCHandler.route(UserService.methods.create, this.create.bind(this)).use(...interceptors));
    register(GRPCHandler.route(UserService.methods.get, this.get.bind(this)).use(...interceptors));
    register(GRPCHandler.route(UserService.methods.list, this.list.bind(this)).use(...interceptors));
    register(GRPCHandler.route(UserService.methods.updateMetadata, this.updateMetadata.bind(this)).use(...interceptors));
    register(GRPCHandler.route(UserService.methods.delete, this.delete.bind(this)).use(...interceptors));
    register(GRPCHandler.route(UserService.methods.enable, this.enable.bind(this)).use(...interceptors));
    register(GRPCHandler.route(UserService.methods.disable, this.disable.bind(this)).use(...interceptors));
  }
}
