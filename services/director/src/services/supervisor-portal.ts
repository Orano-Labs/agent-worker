import type { ConnectRouter, HandlerContext } from "@connectrpc/connect";
import { Scheduler } from "@/core/scheduler";
import { SupervisorRegistry } from "@/core/supervisor-registry";
import {
  SupervisorPortalService,
  type SupervisorPortalServiceFetchRequestValid,
  SupervisorPortalServiceFetchResponseSchema,
  type SupervisorPortalServiceReportRequestValid,
  SupervisorPortalServiceReportResponseSchema,
  TaskSchema,
} from "@/generated/proto/api/v1/supervisor-portal_pb";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { GRPCServer } from "@/internal/grpc-server";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";

export class SupervisorPortalServiceImplementation {
  #repository: Repository;
  #server: GRPCServer;
  #registry: SupervisorRegistry;
  #scheduler: Scheduler;

  #logger: Logger;

  constructor() {
    this.#repository = Container.inject(Repository);
    this.#server = Container.inject(GRPCServer);
    this.#registry = Container.inject(SupervisorRegistry);
    this.#logger = Container.inject(Logger).scope("SupervisorPortalService");
    this.#scheduler = Container.inject(Scheduler);
  }

  async fetch(_: SupervisorPortalServiceFetchRequestValid, context: HandlerContext) {
    const supervisorId = this.#server.getSupervisorIdentityContextMust(context);
    const entry = await this.#scheduler.fetch(supervisorId);

    if (!entry) {
      return Protobuf.createValid(SupervisorPortalServiceFetchResponseSchema, {});
    }

    return Protobuf.createValid(SupervisorPortalServiceFetchResponseSchema, {
      task: Protobuf.createValid(TaskSchema, {
        projectId: entry.job.data.projectId,
        token: entry.token,
      }),
    });
  }

  /**
   * Accept a stream of resource metrics from a Supervisor.
   *
   * This is a client-streaming RPC: the Supervisor sends one or more
   * {@link SupervisorPortalServiceReportRequest} messages on the stream.
   * Each message updates the Supervisor's entry in {@link SupervisorRegistry}.
   *
   * When the stream ends (because the Supervisor disconnects or the connection
   * is lost), the Supervisor is marked as offline.
   */
  async report(stream: AsyncIterable<SupervisorPortalServiceReportRequestValid>, context: HandlerContext) {
    const supervisorId = this.#server.getSupervisorIdentityContextMust(context);

    for await (const report of stream) {
      this.#registry.report(supervisorId, {
        runningProjects: report.runningProjects,
        cpuUsage: report.cpuUsage,
        memoryUsage: report.memoryUsage,
        diskUsage: report.diskUsage,
      });
    }

    // Stream ended — Supervisor disconnected.
    this.#registry.offline(supervisorId);

    return Protobuf.createValid(SupervisorPortalServiceReportResponseSchema, {});
  }

  setup(router: ConnectRouter) {
    router.service(SupervisorPortalService, {
      fetch: (request, context) => {
        return this.fetch(request as SupervisorPortalServiceFetchRequestValid, context);
      },
      report: async (request, context) => {
        return this.report(request as AsyncIterable<SupervisorPortalServiceReportRequestValid>, context);
      },
    });
  }
}
