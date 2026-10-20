import { Logger } from "@aw/logging";
import { createId } from "@orama/cuid2";
import { Base } from "@/api/grpc/base";
import {
  TemplateService,
  TemplateServiceCreateRequest,
  TemplateServiceCreateResponse,
  TemplateServiceDeleteRequest,
  TemplateServiceDeleteResponse,
  TemplateServiceForkRequest,
  TemplateServiceForkResponse,
  TemplateServiceGetRequest,
  TemplateServiceGetResponse,
  TemplateServiceListRequest,
  TemplateServiceListResponse,
  TemplateServiceUpdateMetadataRequest,
  TemplateServiceUpdateMetadataResponse,
  TemplateServiceUpdateStatusRequest,
  TemplateServiceUpdateStatusResponse,
  TemplateStatus,
} from "@/generated/proto/api/v1/template";
import { Authenticator } from "@/internal/authenticator-new";
import { FileSystem } from "@/internal/file-system";
import { GRPCHandler } from "@/internal/grpc-handler";
import { Templates } from "@/internal/templates";

export class TemplateServiceImpl extends Base implements TemplateService<GRPCHandler.Context> {
  #fileSystem: FileSystem;
  #templates: Templates;
  #logger: Logger;

  constructor(...deps: [Authenticator, Templates, FileSystem, Logger]) {
    const logger = deps[3].namespace("GRPC.TemplateServiceImpl");

    super(deps[0], logger);

    this.#templates = deps[1];
    this.#fileSystem = deps[2];
    this.#logger = logger;
  }

  async create(request: TemplateServiceCreateRequest, _: GRPCHandler.Context): Promise<TemplateServiceCreateResponse> {
    const templateId = createId();
    let directoryCreated = false;

    try {
      await this.#fileSystem.createTemplateDirectory(templateId);

      directoryCreated = true;

      const template = await this.#templates.create({
        id: templateId,
        metadata: request.metadata ?? null,
      });

      return {
        template: this.#toTemplate(template),
      };
    } catch (error) {
      if (directoryCreated) {
        await this.#fileSystem.removeTemplateDirectory(templateId).catch((cleanupError) => {
          this.#logger.warn("Failed to clean up template directory.", { templateId, err: cleanupError });
        });
      }

      throw error;
    }
  }

  async updateMetadata(
    request: TemplateServiceUpdateMetadataRequest,
    _: GRPCHandler.Context,
  ): Promise<TemplateServiceUpdateMetadataResponse> {
    const template = await this.#templates.update(request.id, {
      metadata: request.metadata ?? null,
    });

    if (!template) {
      throw GRPCHandler.Error.notFound("Template not found.");
    }

    return {
      template: this.#toTemplate(template),
    };
  }

  async updateStatus(request: TemplateServiceUpdateStatusRequest, _: GRPCHandler.Context): Promise<TemplateServiceUpdateStatusResponse> {
    const template = await this.#templates.update(request.id, {
      status: this.#toDatabaseStatus(request.status),
    });

    if (!template) {
      throw GRPCHandler.Error.notFound("Template not found.");
    }

    return {
      template: this.#toTemplate(template),
    };
  }

  async fork(request: TemplateServiceForkRequest, _: GRPCHandler.Context): Promise<TemplateServiceForkResponse> {
    const source = await this.#templates.get(request.from);

    if (!source) {
      throw GRPCHandler.Error.notFound("Template not found.");
    }

    const templateId = createId();
    let directoryCreated = false;

    try {
      await this.#fileSystem.createTemplateDirectoryFromTemplate(templateId, source.id);

      directoryCreated = true;

      const template = await this.#templates.create({
        id: templateId,
        metadata: request.metadata ?? null,
        sourceTemplateId: source.id,
      });

      return {
        template: this.#toTemplate(template),
      };
    } catch (error) {
      if (directoryCreated) {
        await this.#fileSystem.removeTemplateDirectory(templateId).catch((cleanupError) => {
          this.#logger.warn("Failed to clean up forked template directory.", { templateId, err: cleanupError });
        });
      }

      throw error;
    }
  }

  async get(request: TemplateServiceGetRequest, _: GRPCHandler.Context): Promise<TemplateServiceGetResponse> {
    const template = await this.#templates.get(request.id);

    if (!template) {
      throw GRPCHandler.Error.notFound("Template not found.");
    }

    return {
      template: this.#toTemplate(template),
    };
  }

  async list(request: TemplateServiceListRequest, _: GRPCHandler.Context): Promise<TemplateServiceListResponse> {
    const result = await this.#templates.list({
      page: request.page,
      pageSize: request.pageSize,
      status: request.status === TemplateStatus.UNSPECIFIED ? undefined : this.#toDatabaseStatus(request.status),
    });

    return {
      templates: result.templates.map((template) => this.#toTemplate(template)),
      total: result.total,
    };
  }

  async delete(request: TemplateServiceDeleteRequest, _: GRPCHandler.Context): Promise<TemplateServiceDeleteResponse> {
    const template = await this.#templates.get(request.id);

    if (!template) {
      throw GRPCHandler.Error.notFound("Template not found.");
    }

    const deleted = await this.#templates.delete(request.id);

    if (!deleted) {
      throw GRPCHandler.Error.notFound("Template not found.");
    }

    return {
      template: this.#toTemplate(template),
    };
  }

  #toDatabaseStatus(status: TemplateStatus): Templates.Status {
    switch (status) {
      case TemplateStatus.UNSPECIFIED:
      case TemplateStatus.DRAFT:
        return "DRAFT";
      case TemplateStatus.PUBLISHED:
        return "PUBLISHED";
      case TemplateStatus.ARCHIVED:
        return "ARCHIVED";
      default:
        throw GRPCHandler.Error.invalidArgument("Unknown template status.");
    }
  }

  #toProtoStatus(status: Templates.Status): TemplateStatus {
    switch (status) {
      case "DRAFT":
        return TemplateStatus.DRAFT;
      case "PUBLISHED":
        return TemplateStatus.PUBLISHED;
      case "ARCHIVED":
        return TemplateStatus.ARCHIVED;
      default:
        throw GRPCHandler.Error.internal("Unknown template status.");
    }
  }

  #toTemplate(template: Templates.Template) {
    return {
      id: template.id,
      metadata: template.metadata ?? undefined,
      createTime: template.createTime,
      updateTime: template.updateTime,
      status: this.#toProtoStatus(template.status),
      forkedFrom: template.sourceTemplateId ?? undefined,
    };
  }

  setup(register: (route: GRPCHandler.Route) => void): void {
    const interceptors = [this.createAuthenticationInterceptor(), this.createAccessControlInterceptor("user")];

    register(GRPCHandler.route(TemplateService.methods.create, this.create.bind(this)).use(...interceptors));
    register(GRPCHandler.route(TemplateService.methods.updateMetadata, this.updateMetadata.bind(this)).use(...interceptors));
    register(GRPCHandler.route(TemplateService.methods.updateStatus, this.updateStatus.bind(this)).use(...interceptors));
    register(GRPCHandler.route(TemplateService.methods.fork, this.fork.bind(this)).use(...interceptors));
    register(GRPCHandler.route(TemplateService.methods.get, this.get.bind(this)).use(...interceptors));
    register(GRPCHandler.route(TemplateService.methods.list, this.list.bind(this)).use(...interceptors));
    register(GRPCHandler.route(TemplateService.methods.delete, this.delete.bind(this)).use(...interceptors));
  }
}
