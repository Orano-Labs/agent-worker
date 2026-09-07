import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { ProjectResourceTier } from "@/generated/prisma/enums";
import { ProjectResourceTier as ProjectResourceTierPB } from "@/generated/proto/api/v1/project_pb";
import {
  AcknowledgeStatus,
  EventKeepaliveSchema,
  type EventKeepaliveValid,
  EventLoadListSchema,
  type EventLoadListValid,
  LoadSchema,
  SupervisorPortalService,
  type SupervisorPortalServiceAcknowledgeRequestValid,
  SupervisorPortalServiceAcknowledgeResponseSchema,
  type SupervisorPortalServiceHeartbeatRequestValid,
  SupervisorPortalServiceHeartbeatResponseSchema,
  type SupervisorPortalServiceReleaseRequestValid,
  SupervisorPortalServiceReleaseResponseSchema,
  type SupervisorPortalServiceWatchRequestValid,
  SupervisorPortalServiceWatchResponseSchema,
  type SupervisorPortalServiceWatchResponseValid,
} from "@/generated/proto/api/v1/supervisor-portal_pb";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { Allocator } from "@/internal/allocator";
import { GRPCServer } from "@/internal/grpc-server";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";

export class SupervisorPortalServiceImplementation {
  #server: GRPCServer;
  #logger: Logger;
  #allocator: Allocator;

  #watchers: Map<string, SupervisorPortalServiceImplementation.Watcher>;

  constructor() {
    this.#allocator = Container.inject(Allocator);
    this.#server = Container.inject(GRPCServer);
    this.#logger = Container.inject(Logger).scope("SupervisorPortalService");
    this.#watchers = new Map();
  }

  #watch(request: SupervisorPortalServiceWatchRequestValid, context: HandlerContext) {
    const identity = this.#server.getSupervisorIdentityContextMust(context);
    const processId = request.processId;

    const existing = this.#watchers.get(identity);

    if (existing) {
      if (existing.processId === processId) {
        throw new ConnectError("Supervisor already has an active watch stream", Code.AlreadyExists);
      }

      // Supervisor 重启后携带新的 process_id 重连,接管并关闭旧进程遗留的假死 Watch 流,
      // 否则旧的流会一直占用 watcher 导致新连接反复被 AlreadyExists 拒绝。
      this.#logger.warn("Supervisor restarted, taking over stale watch stream", {
        supervisorId: identity,
        oldProcessId: existing.processId,
        newProcessId: processId,
      });

      existing.close();
    }

    const watcher = new SupervisorPortalServiceImplementation.Watcher(identity, processId, () => {
      this.#watchers.delete(identity);

      this.#logger.debug("Supervisor watch stream closed", { supervisorId: identity });
    });

    this.#watchers.set(identity, watcher);

    return watcher;
  }

  async #acknowledge(request: SupervisorPortalServiceAcknowledgeRequestValid, _: HandlerContext) {
    const pending = this.#allocator.getPending(request.instanceId);

    if (!pending) {
      throw new ConnectError("No pending allocation found for the instance.", Code.NotFound);
    }

    try {
      pending.acknowledge(request.status === AcknowledgeStatus.OK);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Instance acknowledgment already settled")) {
        throw new ConnectError("Instance acknowledgment already settled.", Code.FailedPrecondition);
      }

      throw error;
    }

    return Protobuf.createValid(SupervisorPortalServiceAcknowledgeResponseSchema, {});
  }

  async #heartbeat(request: SupervisorPortalServiceHeartbeatRequestValid, context: HandlerContext) {
    const identity = this.#server.getSupervisorIdentityContextMust(context);
    const processId = request.processId;

    // process_id 用于识别心跳是否来自同一个 Supervisor 进程;
    // 不一致时 Allocator 会销毁旧 Lease 及其遗留的(可能假死的)Tunnel Socket。
    const lease = this.#allocator.getOrCreateLease(identity, processId);

    lease.touch();

    return Protobuf.createValid(SupervisorPortalServiceHeartbeatResponseSchema, {});
  }

  async #release(request: SupervisorPortalServiceReleaseRequestValid, context: HandlerContext) {
    const identity = this.#server.getSupervisorIdentityContextMust(context);

    await this.#allocator.release(request.instanceId, identity);

    return Protobuf.createValid(SupervisorPortalServiceReleaseResponseSchema, {});
  }

  setup(router: ConnectRouter) {
    router.service(SupervisorPortalService, {
      watch: (request, context) => {
        return this.#watch(request as SupervisorPortalServiceWatchRequestValid, context);
      },
      acknowledge: async (request, context) => {
        return this.#acknowledge(request as SupervisorPortalServiceAcknowledgeRequestValid, context);
      },
      heartbeat: async (request, context) => {
        return this.#heartbeat(request as SupervisorPortalServiceHeartbeatRequestValid, context);
      },
      release: async (request, context) => {
        return this.#release(request as SupervisorPortalServiceReleaseRequestValid, context);
      },
    });
  }
}

export namespace SupervisorPortalServiceImplementation {
  export const WATCH_QUEUE_LIMIT = 256;
  export const WATCH_KEEPALIVE_INTERVAL_MS = 15_000;

  type QueueItem = {
    response: SupervisorPortalServiceWatchResponseValid;
  };

  type EnqueueEvent = { case: "keepalive"; value: EventKeepaliveValid } | { case: "load"; value: EventLoadListValid };

  export class Watcher {
    #logger: Logger;
    #repository: Repository;
    #allocator: Allocator;
    #supervisor: string;
    #onClose: () => void;

    #queue: QueueItem[] = [];
    #wake: (() => void) | null = null;
    #closed = false;
    #keepaliveTimer: ReturnType<typeof setInterval>;
    #unsubscribe: () => void;
    #processId: string;

    constructor(supervisor: string, processId: string, onClose: () => void) {
      this.#logger = Container.inject(Logger).scope("Watcher");
      this.#repository = Container.inject(Repository);
      this.#allocator = Container.inject(Allocator);
      this.#supervisor = supervisor;
      this.#processId = processId;
      this.#onClose = onClose;

      this.#unsubscribe = this.#allocator.onChange(supervisor, () => {
        void this.#publishLoad();
      });

      this.#keepaliveTimer = setInterval(() => this.#tickKeepalive(), WATCH_KEEPALIVE_INTERVAL_MS);
      this.#keepaliveTimer.unref?.();

      // 连接建立时先下发一次当前负载，便于 Supervisor 重建状态
      void this.#publishLoad();
    }

    get closed() {
      return this.#closed;
    }

    get processId() {
      return this.#processId;
    }

    close() {
      if (this.#closed) {
        return;
      }

      this.#closed = true;
      clearInterval(this.#keepaliveTimer);
      this.#unsubscribe();

      this.#queue.length = 0;
      this.#notify();
      this.#onClose();
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<SupervisorPortalServiceWatchResponseValid, void, void> {
      try {
        while (!this.#closed) {
          const next = this.#queue.shift();

          if (next) {
            yield next.response;
            continue;
          }

          await this.#wait();
        }
      } finally {
        // 客户端断开（框架停止拉取）时兜底清理。
        this.close();
      }
    }

    async #publishLoad() {
      if (this.#closed) {
        return;
      }

      try {
        const instances = await this.#repository.client.instance.findMany({
          where: {
            supervisorId: this.#supervisor,
          },
          select: {
            id: true,
            confirmed: true,
            project: {
              select: {
                resourceTier: true,
                id: true,
              },
            },
          },
        });

        const event = Protobuf.createValid(EventLoadListSchema, {
          list: instances.map((inst) =>
            Protobuf.createValid(LoadSchema, {
              instanceId: inst.id,
              projectId: inst.project.id,
              projectResourceTier: this.#mapResourceTierFromRepository(inst.project.resourceTier),
              confirmed: inst.confirmed,
              timestamp: Protobuf.Timestamp.now(),
            }),
          ),
        });

        this.#enqueue({ case: "load", value: event });
      } catch (error) {
        this.#logger.error("Failed to publish load", { err: error, supervisor: this.#supervisor });
      }
    }

    #enqueue(event: EnqueueEvent) {
      if (this.#closed) {
        return;
      }

      if (this.#queue.length >= WATCH_QUEUE_LIMIT) {
        this.#logger.warn("Watcher queue overflow, dropping event", { case: event.case });
        return;
      }

      const response = Protobuf.createValid(SupervisorPortalServiceWatchResponseSchema, {
        event,
      });

      this.#queue.push({ response });

      this.#logger.debug("Event enqueued for delivery", { case: event.case });
      this.#notify();
    }

    #tickKeepalive() {
      if (this.#closed || this.#queue.length > 0) {
        return;
      }

      const response = Protobuf.createValid(SupervisorPortalServiceWatchResponseSchema, {
        event: {
          case: "keepalive",
          value: Protobuf.createValid(EventKeepaliveSchema, {}),
        },
      });

      this.#queue.push({ response });
      this.#notify();
    }

    #mapResourceTierFromRepository(value: ProjectResourceTier) {
      switch (value) {
        case ProjectResourceTier.Minimum:
          return ProjectResourceTierPB.MINIMUM;
        case ProjectResourceTier.Standard:
          return ProjectResourceTierPB.STANDARD;
        case ProjectResourceTier.Performance:
          return ProjectResourceTierPB.PERFORMANCE;
        default:
          throw new Error("Unknown resource tier");
      }
    }

    #wait() {
      return new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }

    #notify() {
      const wake = this.#wake;
      this.#wake = null;
      wake?.();
    }
  }
}
