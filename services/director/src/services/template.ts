import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { createId } from "@orama/cuid2";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { TemplateStatus as DBTemplateStatus } from "@/generated/prisma/enums";
import {
  TemplateSchema,
  TemplateService,
  type TemplateServiceCreateRequestValid,
  TemplateServiceCreateResponseSchema,
  type TemplateServiceDeleteRequestValid,
  TemplateServiceDeleteResponseSchema,
  type TemplateServiceForkRequestValid,
  TemplateServiceForkResponseSchema,
  type TemplateServiceGetRequestValid,
  TemplateServiceGetResponseSchema,
  type TemplateServiceListRequestValid,
  TemplateServiceListResponseSchema,
  type TemplateServiceUpdateMetadataRequestValid,
  TemplateServiceUpdateMetadataResponseSchema,
  type TemplateServiceUpdateStatusRequestValid,
  TemplateServiceUpdateStatusResponseSchema,
  TemplateStatus,
} from "@/generated/proto/api/v1/template_pb";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";
import { Variables } from "@/internal/variables";

const MAP_TEMPLATE_STATUS = {
  [TemplateStatus.UNSPECIFIED]: DBTemplateStatus.Draft,
  [TemplateStatus.PUBLISHED]: DBTemplateStatus.Published,
  [TemplateStatus.DRAFT]: DBTemplateStatus.Draft,
  [TemplateStatus.ARCHIVED]: DBTemplateStatus.Archived,
} satisfies Record<TemplateStatus, DBTemplateStatus>;

const MAP_TEMPLATE_STATUS_REVERSE = {
  [DBTemplateStatus.Published]: TemplateStatus.PUBLISHED,
  [DBTemplateStatus.Draft]: TemplateStatus.DRAFT,
  [DBTemplateStatus.Archived]: TemplateStatus.ARCHIVED,
} satisfies Record<DBTemplateStatus, TemplateStatus>;

export class TemplateServiceImplementation {
  #repository: Repository;
  #variables: Variables;
  #logger: Logger;

  constructor() {
    this.#repository = Container.inject(Repository);
    this.#variables = Container.inject(Variables);
    this.#logger = Container.inject(Logger).scope("TemplateService");
  }

  async create(request: TemplateServiceCreateRequestValid, _: HandlerContext) {
    const root = this.#variables.get("AW_DIRECTOR_FS_ROOT");

    if (!root) {
      throw new ConnectError("File system root not configured.", Code.Unavailable);
    }

    const id = createId();
    const dir = join(root, "templates", id);

    try {
      const template = await mkdir(dir, { recursive: true }).then(async () => {
        return this.#repository.client.template.create({
          data: {
            id,
            metadata: request.metadata ? Uint8Array.from(request.metadata) : null,
          },
        });
      });

      return Protobuf.createValid(TemplateServiceCreateResponseSchema, {
        template: Protobuf.createValid(TemplateSchema, {
          id: template.id,
          createTime: Protobuf.Timestamp.fromDate(template.createTime),
          updateTime: Protobuf.Timestamp.fromDate(template.updateTime),
          metadata: template.metadata === null ? undefined : template.metadata,
          status: MAP_TEMPLATE_STATUS_REVERSE[template.status],
        }),
      });
    } catch (error) {
      rm(dir, { recursive: true }).catch((err) => {
        this.#logger.error("Failed to rollback template directory creation", {
          directory: dir,
          err: err,
        });
      });

      throw error;
    }
  }

  async get(request: TemplateServiceGetRequestValid, _: HandlerContext) {
    const template = await this.#repository.client.template.findUnique({
      where: {
        id: request.id,
        deleteTime: null,
      },
    });

    if (!template) {
      throw new ConnectError("Template not found.", Code.NotFound);
    }

    return Protobuf.createValid(TemplateServiceGetResponseSchema, {
      template: Protobuf.createValid(TemplateSchema, {
        id: template.id,
        createTime: Protobuf.Timestamp.fromDate(template.createTime),
        updateTime: Protobuf.Timestamp.fromDate(template.updateTime),
        metadata: template.metadata === null ? undefined : template.metadata,
        status: MAP_TEMPLATE_STATUS_REVERSE[template.status],
        forkedFrom: template.sourceTemplateId === null ? undefined : template.sourceTemplateId,
      }),
    });
  }

  async delete(request: TemplateServiceDeleteRequestValid, _: HandlerContext) {
    const template = await this.#repository.client.template
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
          throw new ConnectError("Template not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(TemplateServiceDeleteResponseSchema, {
      template: Protobuf.createValid(TemplateSchema, {
        id: template.id,
        createTime: Protobuf.Timestamp.fromDate(template.createTime),
        updateTime: Protobuf.Timestamp.fromDate(template.updateTime),
        metadata: template.metadata === null ? undefined : template.metadata,
        status: MAP_TEMPLATE_STATUS_REVERSE[template.status],
      }),
    });
  }

  async updateMetadata(request: TemplateServiceUpdateMetadataRequestValid, _: HandlerContext) {
    const template = await this.#repository.client.template
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
          throw new ConnectError("Template not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(TemplateServiceUpdateMetadataResponseSchema, {
      template: Protobuf.createValid(TemplateSchema, {
        id: template.id,
        createTime: Protobuf.Timestamp.fromDate(template.createTime),
        updateTime: Protobuf.Timestamp.fromDate(template.updateTime),
        metadata: template.metadata === null ? undefined : template.metadata,
        status: MAP_TEMPLATE_STATUS_REVERSE[template.status],
        forkedFrom: template.sourceTemplateId === null ? undefined : template.sourceTemplateId,
      }),
    });
  }

  async updateStatus(request: TemplateServiceUpdateStatusRequestValid, _: HandlerContext) {
    const template = await this.#repository.client.template
      .update({
        where: {
          id: request.id,
          deleteTime: null,
        },
        data: {
          status: MAP_TEMPLATE_STATUS[request.status],
        },
      })
      .catch((error) => {
        if (error instanceof PrismaClientKnownRequestError && error.code === "P2025") {
          throw new ConnectError("Template not found.", Code.NotFound);
        }

        throw error;
      });

    return Protobuf.createValid(TemplateServiceUpdateStatusResponseSchema, {
      template: Protobuf.createValid(TemplateSchema, {
        id: template.id,
        createTime: Protobuf.Timestamp.fromDate(template.createTime),
        updateTime: Protobuf.Timestamp.fromDate(template.updateTime),
        metadata: template.metadata === null ? undefined : template.metadata,
        status: MAP_TEMPLATE_STATUS_REVERSE[template.status],
        forkedFrom: template.sourceTemplateId === null ? undefined : template.sourceTemplateId,
      }),
    });
  }

  async list(request: TemplateServiceListRequestValid, _: HandlerContext) {
    const take = request.pageSize;
    const skip = (request.page - 1) * take;

    const [templates, total] = await Promise.all([
      await this.#repository.client.template.findMany({
        where: {
          deleteTime: null,
        },
        orderBy: {
          createTime: "desc",
        },
        take,
        skip,
      }),

      await this.#repository.client.template.count({
        where: {
          deleteTime: null,
        },
      }),
    ]);

    return Protobuf.createValid(TemplateServiceListResponseSchema, {
      total,
      templates: templates.map((template) =>
        Protobuf.createValid(TemplateSchema, {
          id: template.id,
          createTime: Protobuf.Timestamp.fromDate(template.createTime),
          updateTime: Protobuf.Timestamp.fromDate(template.updateTime),
          metadata: template.metadata === null ? undefined : template.metadata,
          status: MAP_TEMPLATE_STATUS_REVERSE[template.status],
          forkedFrom: template.sourceTemplateId === null ? undefined : template.sourceTemplateId,
        }),
      ),
    });
  }

  async fork(request: TemplateServiceForkRequestValid, _: HandlerContext) {
    const root = this.#variables.get("AW_DIRECTOR_FS_ROOT");

    if (!root) {
      throw new ConnectError("File system root not configured.", Code.Unavailable);
    }

    const source = await this.#repository.client.template.findUnique({
      where: {
        id: request.from,
        deleteTime: null,
      },
    });

    if (!source) {
      throw new ConnectError("Template not found.", Code.NotFound);
    }

    const id = createId();
    const dir = join(root, "templates", id);

    try {
      const template = await cp(join(root, "templates", source.id), dir, { recursive: true }).then(() => {
        return this.#repository.client.template.create({
          data: {
            id,
            sourceTemplateId: source.id,
            metadata: request.metadata ? Uint8Array.from(request.metadata) : null,
          },
        });
      });

      return Protobuf.createValid(TemplateServiceForkResponseSchema, {
        template: Protobuf.createValid(TemplateSchema, {
          id: template.id,
          createTime: Protobuf.Timestamp.fromDate(template.createTime),
          updateTime: Protobuf.Timestamp.fromDate(template.updateTime),
          metadata: template.metadata === null ? undefined : template.metadata,
          status: MAP_TEMPLATE_STATUS_REVERSE[template.status],
          forkedFrom: template.sourceTemplateId === null ? undefined : template.sourceTemplateId,
        }),
      });
    } catch (error) {
      rm(dir, { recursive: true, force: true }).catch((err) => {
        this.#logger.error("Failed to rollback forked template directory creation", { directory: dir, error: err });
      });

      throw error;
    }
  }

  setup(router: ConnectRouter) {
    router.service(TemplateService, {
      create: async (request, context) => {
        return this.create(request as TemplateServiceCreateRequestValid, context);
      },
      get: async (request, context) => {
        return this.get(request as TemplateServiceGetRequestValid, context);
      },
      delete: async (request, context) => {
        return this.delete(request as TemplateServiceDeleteRequestValid, context);
      },
      updateMetadata: async (request, context) => {
        return this.updateMetadata(request as TemplateServiceUpdateMetadataRequestValid, context);
      },
      updateStatus: async (request, context) => {
        return this.updateStatus(request as TemplateServiceUpdateStatusRequestValid, context);
      },
      list: async (request, context) => {
        return this.list(request as TemplateServiceListRequestValid, context);
      },
      fork: async (request, context) => {
        return this.fork(request as TemplateServiceForkRequestValid, context);
      },
    });
  }
}
