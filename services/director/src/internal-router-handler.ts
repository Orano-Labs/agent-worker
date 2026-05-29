import { type WebSocket, WebSocketServer } from "ws";
import { Authenticator } from "@/core/services/authenticator";
import { Scheduler } from "@/core/services/scheduler";
import { Container } from "@/helpers/container";
import { HTTPServer } from "@/internal/http-server";
import { Logger } from "@/internal/logger";

export class InternalRouterHandler {
  #logger: Logger;
  #http: HTTPServer;
  #authenticator: Authenticator;
  #scheduler: Scheduler;

  #wss: WebSocketServer;

  constructor() {
    this.#wss = new WebSocketServer({ noServer: true });

    this.#logger = Container.inject(Logger).scope("InternalRouter");
    this.#http = Container.inject(HTTPServer);
    this.#authenticator = Container.inject(Authenticator);
    this.#scheduler = Container.inject(Scheduler);
  }

  setup() {
    this.#http.server.on("upgrade", async (req, socket, head) => {
      const connectionId = crypto.randomUUID();
      const ip = req.socket.remoteAddress || "unknown";

      const url = new URL(req.url || "", "http://127.0.0.1");

      if (url.pathname !== "/supervisor/join" || req.method?.toUpperCase() !== "GET") {
        this.#logger.warn("Rejecting upgrade request: invalid endpoint", {
          method: req.method || "UNKNOWN",
          url: req.url || "",
          ip,
          connectionId,
        });

        socket.write("HTTP/1.1 404 Not found\r\n\r\n");
        socket.destroy();

        return;
      }

      this.#logger.info("Received supervisor upgrade request, starting authentication", {
        connectionId,
        ip,
        headers: {
          "x-supervisor-id": req.headers["x-supervisor-id"],
          "x-timestamp": req.headers["x-timestamp"],
          "x-nonce": req.headers["x-nonce"],
          "x-signature": req.headers["x-signature"],
        },
      });

      const handleSocketError = (error: Error) => {
        this.#logger.error("Socket error occurred during supervisor connection setup", {
          connectionId,
          err: error,
        });

        if (!socket.destroyed) {
          socket.destroy();
        }
      };

      try {
        const credentials = await this.#authenticator.authenticateSupervisorConnect(req);

        if (credentials.isErr()) {
          this.#logger.warn("Supervisor authentication failed", {
            connectionId,
            reason: credentials.error.message,
          });

          socket.write(`HTTP/1.1 401 Unauthorized\r\n\r\n`);
          socket.destroy();

          return;
        }

        this.#logger.info("Supervisor authenticated successfully, upgrading protocol", {
          connectionId,
        });

        socket.removeListener("error", handleSocketError);

        const ws = await new Promise<WebSocket>((resolve) => {
          this.#wss.handleUpgrade(req, socket, head, (ws) => {
            resolve(ws);
          });
        });

        const result = await this.#scheduler.register(connectionId, ws, credentials.value);

        if (result.isErr()) {
          this.#logger.warn("Supervisor registration failed", {
            connectionId,
            reason: result.error.message,
          });

          socket.write(`HTTP/1.1 409 Conflict\r\n\r\n`);
          socket.destroy();

          return;
        }

        this.#logger.info("Supervisor WebSocket connection fully established and registered", {
          connectionId,
        });
      } catch (error) {
        this.#logger.error("Exception occurred during supervisor upgrade workflow", {
          err: error,
          connectionId,
        });

        if (!socket.destroyed) {
          socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
          socket.destroy();
        }
      } finally {
        socket.removeListener("error", handleSocketError);
      }
    });

    this.#logger.info("Supervisor WebSocket endpoint ready", {
      url: `${this.#http.url.replace("http://", "ws://")}/supervisor/join`,
    });
  }
}
