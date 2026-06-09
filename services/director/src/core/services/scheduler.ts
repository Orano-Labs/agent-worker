import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import type { WebSocket } from "ws";
import type { Supervisor } from "@/contracts/supervisor";
import type { Authenticator } from "@/core/services/authenticator";
import { Container } from "@/helpers/container";
import { Result } from "@/helpers/result";
import { Logger } from "@/internal/logger";

export class Scheduler {
  #supervisors: Map<string, Scheduler.Supervisor>;
  #logger: Logger;

  constructor() {
    this.#supervisors = new Map();

    this.#logger = Container.inject(Logger).scope("Scheduler");
  }

  async register(
    connectionId: string,
    ws: WebSocket,
    credentials: Authenticator.SupervisorCredentials,
  ): Promise<Result<void, { message: string }>> {
    if (ws.readyState !== ws.OPEN) {
      return Result.error({ message: "WebSocket is not open" });
    }

    const existing = this.#supervisors.get(credentials.id);

    // 如果在两分钟内没有收到任何消息但 Socket 依然是打开状态
    // 此时应该认为这个连接是不正常的；应该将旧连接强制断开并采纳新链接
    if (existing) {
      if (existing.lastSeen.getTime() + 1000 * 60 * 2 > Date.now() || existing.ws.readyState !== existing.ws.OPEN) {
        this.#logger.warn("Supervisor already registered, and connection is verified alive in 2 min slot. Rejecting new attempt.", {
          supervisorId: credentials.id,
          existingConnectionId: existing.connectionId,
          connectionId: connectionId,
        });

        return Result.error({ message: "Supervisor already registered" });
      }

      this.#logger.warn("Supervisor connection expired (inactive for >2m). Cleaning up stale connection.", {
        supervisorId: credentials.id,
        staleConnectionId: existing.connectionId,
      });

      existing.ws.terminate();
    }

    const connection: Scheduler.Supervisor = {
      connectionId,
      credentials,
      ws,
      lastSeen: new Date(),
      controller: createORPCClient(new RPCLink({ websocket: ws })),
      helthCheckTimmer: setInterval(() => {}, 1000),
    };

    this.#supervisors.set(credentials.id, connection);

    connection.ws.on("close", (code) => {
      this.#supervisors.delete(credentials.id);
      this.#logger.info("Supervisor WebSocket connection closed", {
        connectionId,
        code,
      });

      clearInterval(connection.helthCheckTimmer);
    });

    return Result.ok();
  }

  get supervisors() {
    return this.#supervisors;
  }

  start() {}
}

export namespace Scheduler {
  export type Supervisor = {
    connectionId: string;
    credentials: Authenticator.SupervisorCredentials;
    ws: WebSocket;
    lastSeen: Date;
    controller: ContractRouterClient<typeof Supervisor.CONTROLLER_CONTRACT>;
    helthCheckTimmer: ReturnType<typeof setInterval>;
    latestHelthCheckReport?: {
      timestamp: Date;
      report: {};
    };
  };
}
