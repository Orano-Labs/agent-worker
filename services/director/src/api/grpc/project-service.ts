import { Logger } from "@aw/logging";
import { Base } from "@/api/grpc/base";
import {
  ProjectResourceTier,
  ProjectService,
  ProjectServiceCreateRequest,
  ProjectServiceCreateResponse,
  ProjectServiceDeleteRequest,
  ProjectServiceDeleteResponse,
  ProjectServiceGetRequest,
  ProjectServiceGetResponse,
  ProjectServiceListRequest,
  ProjectServiceListResponse,
  ProjectServiceUpdateMetadataRequest,
  ProjectServiceUpdateMetadataResponse,
} from "@/generated/proto/api/v1/project";
import { Authenticator } from "@/internal/authenticator-new";
import { GRPCHandler } from "@/internal/grpc-handler";
import { Projects } from "@/internal/projects";
import { Templates } from "@/internal/templates";

export class ProjectServiceImpl extends Base implements ProjectService<GRPCHandler.Context> {
  #projects: Projects;
  #templates: Templates;

  constructor(...deps: [Authenticator, Projects, Templates, Logger]) {
    const logger = deps[3].namespace("GRPC.ProjectServiceImpl");

    super(deps[0], logger);

    this.#projects = deps[1];
    this.#templates = deps[2];
  }

  async create(request: ProjectServiceCreateRequest, context: GRPCHandler.Context): Promise<ProjectServiceCreateResponse> {
    const owner = this.getAuthenticationIdentityMust(context, "user");

    if (request.templateId) {
      const template = await this.#templates.get(request.templateId);

      if (!template) {
        throw GRPCHandler.Error.notFound("Template not found.");
      }
    }

    // TODO: create the project workspace directory and copy template contents when a template is provided.

    const project = await this.#projects.create({
      ownerId: owner.id,
      metadata: request.metadata ?? null,
      resourceTier: this.#toResourceTier(request.resourceTier),
      templateId: request.templateId ?? null,
      supervisorId: request.supervisorId ?? null,
      workspace: request.workspace ?? null,
    });

    return {
      project: this.#toProject(project),
    };
  }

  async get(request: ProjectServiceGetRequest, context: GRPCHandler.Context): Promise<ProjectServiceGetResponse> {
    const owner = this.getAuthenticationIdentityMust(context, "user");
    const project = await this.#projects.get(request.id);

    if (!project || project.ownerId !== owner.id) {
      throw GRPCHandler.Error.notFound("Project not found.");
    }

    return {
      project: this.#toProject(project),
    };
  }

  async list(request: ProjectServiceListRequest, context: GRPCHandler.Context): Promise<ProjectServiceListResponse> {
    const owner = this.getAuthenticationIdentityMust(context, "user");

    const result = await this.#projects.list({
      page: request.page,
      pageSize: request.pageSize,
      ownerId: owner.id,
    });

    return {
      projects: result.projects.map((project) => this.#toProject(project)),
      total: result.total,
    };
  }

  async updateMetadata(
    request: ProjectServiceUpdateMetadataRequest,
    context: GRPCHandler.Context,
  ): Promise<ProjectServiceUpdateMetadataResponse> {
    const owner = this.getAuthenticationIdentityMust(context, "user");
    const existing = await this.#projects.get(request.id);

    if (!existing || existing.ownerId !== owner.id) {
      throw GRPCHandler.Error.notFound("Project not found.");
    }

    const project = await this.#projects.update(request.id, {
      metadata: request.metadata ?? null,
    });

    if (!project) {
      throw GRPCHandler.Error.notFound("Project not found.");
    }

    return {
      project: this.#toProject(project),
    };
  }

  async delete(request: ProjectServiceDeleteRequest, context: GRPCHandler.Context): Promise<ProjectServiceDeleteResponse> {
    const owner = this.getAuthenticationIdentityMust(context, "user");
    const project = await this.#projects.get(request.id);

    if (!project || project.ownerId !== owner.id) {
      throw GRPCHandler.Error.notFound("Project not found.");
    }

    // TODO: prevent deletion while an instance exists.
    // TODO: remove the project workspace directory.

    const deleted = await this.#projects.delete(request.id);

    if (!deleted) {
      throw GRPCHandler.Error.notFound("Project not found.");
    }

    return {};
  }

  #toResourceTier(resourceTier: ProjectResourceTier): Projects.ResourceTier {
    switch (resourceTier) {
      case ProjectResourceTier.UNSPECIFIED:
      case ProjectResourceTier.MINIMUM:
        return "MINIMUM";
      case ProjectResourceTier.STANDARD:
        return "STANDARD";
      case ProjectResourceTier.PERFORMANCE:
        return "PERFORMANCE";
      default:
        throw GRPCHandler.Error.invalidArgument("Unknown project resource tier.");
    }
  }

  #toProtoResourceTier(resourceTier: Projects.ResourceTier): ProjectResourceTier {
    switch (resourceTier) {
      case "MINIMUM":
        return ProjectResourceTier.MINIMUM;
      case "STANDARD":
        return ProjectResourceTier.STANDARD;
      case "PERFORMANCE":
        return ProjectResourceTier.PERFORMANCE;
      default:
        throw GRPCHandler.Error.internal("Unknown project resource tier.");
    }
  }

  #toProject(project: Projects.Project) {
    return {
      id: project.id,
      metadata: project.metadata ?? undefined,
      createTime: project.createTime,
      updateTime: project.updateTime,
      resourceTier: this.#toProtoResourceTier(project.resourceTier),
      templateId: project.templateId ?? undefined,
      supervisorId: project.supervisorId ?? undefined,
      workspace: project.workspace ?? undefined,
    };
  }

  setup(register: (route: GRPCHandler.Route) => void): void {
    const interceptors = [this.createAuthenticationInterceptor(), this.createAccessControlInterceptor("user")];

    register(GRPCHandler.route(ProjectService.methods.create, this.create.bind(this)).use(...interceptors));
    register(GRPCHandler.route(ProjectService.methods.list, this.list.bind(this)).use(...interceptors));
    register(GRPCHandler.route(ProjectService.methods.get, this.get.bind(this)).use(...interceptors));
    register(GRPCHandler.route(ProjectService.methods.delete, this.delete.bind(this)).use(...interceptors));
    register(GRPCHandler.route(ProjectService.methods.updateMetadata, this.updateMetadata.bind(this)).use(...interceptors));
  }
}
