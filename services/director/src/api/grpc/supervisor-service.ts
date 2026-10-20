import { Logger } from "@aw/logging";
import { Base } from "@/api/grpc/base";
import {
  SupervisorService,
  SupervisorServiceCreateRequest,
  SupervisorServiceCreateResponse,
  SupervisorServiceDeleteRequest,
  SupervisorServiceDeleteResponse,
  SupervisorServiceGetRequest,
  SupervisorServiceGetResponse,
  SupervisorServiceListRequest,
  SupervisorServiceListResponse,
  SupervisorServiceUpdateMetadataRequest,
  SupervisorServiceUpdateMetadataResponse,
} from "@/generated/proto/api/v1/supervisor";
import { Authenticator } from "@/internal/authenticator-new";
import { GRPCHandler } from "@/internal/grpc-handler";
import { Supervisors } from "@/internal/supervisors";

export class SupervisorServiceImpl extends Base implements SupervisorService<GRPCHandler.Context> {
  #authenticator: Authenticator;
  #supervisors: Supervisors;

  constructor(...deps: [Authenticator, Supervisors, Logger]) {
    const logger = deps[2].namespace("GRPC.SupervisorServiceImpl");

    super(deps[0], logger);

    this.#authenticator = deps[0];
    this.#supervisors = deps[1];
  }

  async create(request: SupervisorServiceCreateRequest, context: GRPCHandler.Context): Promise<SupervisorServiceCreateResponse> {
    const identity = this.getAuthenticationIdentityMust(context, "user", "manager");
    const [publicKey, privateKey] = await this.#authenticator.generateKeyPair();

    const supervisor = await this.#supervisors.create({
      publicKey,
      metadata: request.metadata ?? null,
      capacity: request.capacity,
      ownerId: identity.type === "user" ? identity.id : null,
    });

    return {
      supervisor: this.#toSupervisor(supervisor),
      privateKey,
    };
  }

  async updateMetadata(
    request: SupervisorServiceUpdateMetadataRequest,
    context: GRPCHandler.Context,
  ): Promise<SupervisorServiceUpdateMetadataResponse> {
    const ownerId = this.#getOwnerId(context);
    const existing = await this.#supervisors.get(request.id);

    if (!existing || existing.ownerId !== ownerId) {
      throw GRPCHandler.Error.notFound("Supervisor not found.");
    }

    const supervisor = await this.#supervisors.update(request.id, {
      metadata: request.metadata ?? null,
    });

    if (!supervisor) {
      throw GRPCHandler.Error.notFound("Supervisor not found.");
    }

    return {
      supervisor: this.#toSupervisor(supervisor),
    };
  }

  async delete(request: SupervisorServiceDeleteRequest, context: GRPCHandler.Context): Promise<SupervisorServiceDeleteResponse> {
    const ownerId = this.#getOwnerId(context);
    const supervisor = await this.#supervisors.get(request.id);

    if (!supervisor || supervisor.ownerId !== ownerId) {
      throw GRPCHandler.Error.notFound("Supervisor not found.");
    }

    // TODO: reject deletion while the supervisor is online.

    const deleted = await this.#supervisors.delete(request.id);

    if (!deleted) {
      throw GRPCHandler.Error.notFound("Supervisor not found.");
    }

    return {};
  }

  async get(request: SupervisorServiceGetRequest, context: GRPCHandler.Context): Promise<SupervisorServiceGetResponse> {
    const ownerId = this.#getOwnerId(context);
    const supervisor = await this.#supervisors.get(request.id);

    if (!supervisor || supervisor.ownerId !== ownerId) {
      throw GRPCHandler.Error.notFound("Supervisor not found.");
    }

    return {
      supervisor: this.#toSupervisor(supervisor),
    };
  }

  async list(request: SupervisorServiceListRequest, context: GRPCHandler.Context): Promise<SupervisorServiceListResponse> {
    const ownerId = this.#getOwnerId(context);

    const result = await this.#supervisors.list({
      page: request.page,
      pageSize: request.pageSize,
      ownerId,
    });

    return {
      supervisors: result.supervisors.map((supervisor) => this.#toSupervisor(supervisor)),
      total: result.total,
    };
  }

  #getOwnerId(context: GRPCHandler.Context) {
    const identity = this.getAuthenticationIdentityMust(context, "user", "manager");

    return identity.type === "user" ? identity.id : null;
  }

  #toSupervisor(supervisor: Supervisors.Supervisor) {
    return {
      id: supervisor.id,
      publicKey: supervisor.publicKey,
      metadata: supervisor.metadata ?? undefined,
      createTime: supervisor.createTime,
      updateTime: supervisor.updateTime,
      // TODO: resolve online state from the supervisor lease registry.
      online: false,
      capacity: supervisor.capacity,
    };
  }

  setup(register: (route: GRPCHandler.Route) => void): void {
    const interceptors = [this.createAuthenticationInterceptor(), this.createAccessControlInterceptor("user", "manager")];

    register(GRPCHandler.route(SupervisorService.methods.create, this.create.bind(this)).use(...interceptors));
    register(GRPCHandler.route(SupervisorService.methods.updateMetadata, this.updateMetadata.bind(this)).use(...interceptors));
    register(GRPCHandler.route(SupervisorService.methods.delete, this.delete.bind(this)).use(...interceptors));
    register(GRPCHandler.route(SupervisorService.methods.get, this.get.bind(this)).use(...interceptors));
    register(GRPCHandler.route(SupervisorService.methods.list, this.list.bind(this)).use(...interceptors));
  }
}
