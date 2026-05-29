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
  #connections: Map<string, Scheduler.Connection>;
  #logger: Logger;

  constructor() {
    this.#connections = new Map();

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

    const existing = this.#connections.get(credentials.id);

    if (existing) {
      if (existing.lastSeen.getTime() + 1000 * 60 * 2 > Date.now()) {
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

    const connection: Scheduler.Connection = {
      connectionId,
      credentials,
      ws,
      lastSeen: new Date(),
      controller: createORPCClient(new RPCLink({ websocket: ws })),
    };

    this.#connections.set(credentials.id, connection);

    connection.controller.host
      .status(undefined, {
        signal: AbortSignal.timeout(1000),
      })
      .then((result) => {
        console.log(result);
      })
      .catch((error) => {
        console.log(error);
      });

    ws.on("close", (code) => {
      this.#connections.delete(credentials.id);
      this.#logger.info("Supervisor WebSocket connection closed", {
        connectionId,
        code,
      });
    });

    return Result.ok();
  }

  start() {}
}

export namespace Scheduler {
  export type Connection = {
    connectionId: string;
    credentials: Authenticator.SupervisorCredentials;
    ws: WebSocket;
    lastSeen: Date;
    controller: ContractRouterClient<typeof Supervisor.CONTROLLER_CONTRACT>;
  };
}
