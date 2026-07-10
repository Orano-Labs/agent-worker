import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

import { Container } from "@/helpers/container";
import { HTTPServer } from "@/internal/http-server";
import { Logger } from "@/internal/logger";

/** Result of a successful WebSocket upgrade authentication. */
type AuthenticatedUpgrade = {
  projectId: string;
  credential: string;
  side: "client" | "runner";
};

export class WEBSocketServer {
  #http: HTTPServer;
  #wss: WebSocketServer;
  #logger: Logger;

  constructor() {
    this.#http = Container.inject(HTTPServer);
    this.#wss = new WebSocketServer({ noServer: true });
    this.#logger = Container.inject(Logger).scope("WEBSocketServer");
  }

  #authenticate(req: IncomingMessage, socket: Duplex): AuthenticatedUpgrade | null {
    const url = req.url ?? "/";
    const index = url.indexOf("?");
    const path = index >= 0 ? url.slice(0, index) : url;

    if (path !== "/ws") {
      this.#respond(socket, 404, "Not Found.");
      return null;
    }

    if (index < 0) {
      this.#respond(socket, 400, "Missing query parameters.");
      return null;
    }

    const params = new URLSearchParams(url.slice(index));
    const projectId = params.get("projectId");
    const credential = params.get("credential");
    const side = params.get("side");

    if (!projectId || !credential) {
      this.#respond(socket, 400, "Missing projectId or credential.");
      return null;
    }

    if (side !== "client" && side !== "runner") {
      this.#respond(socket, 400, "Missing or invalid side parameter (expected 'client' or 'runner').");
      return null;
    }

    // TODO: validate credential against the scheduler's expected value.

    return { projectId, credential, side };
  }

  /**
   * Write an HTTP error response and destroy the socket.
   *
   * Used when a WebSocket upgrade request fails authentication so the client
   * receives a meaningful status code instead of a silent connection drop.
   */
  #respond(socket: Duplex, status: number, message: string) {
    const body = `${status} ${message}`;

    try {
      socket.write(
        `HTTP/1.1 ${status} ${message}\r\n` +
          `Content-Type: text/plain\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: close\r\n` +
          `\r\n` +
          body,
      );
    } catch {
      // Socket may already be closing.
    }

    socket.destroy();
  }

  setup() {
    this.#http.server.on("upgrade", (req, socket, head) => {
      const ident = this.#authenticate(req, socket);

      if (!ident) {
        return;
      }

      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        this.#wss.emit("connection", ws, req);
      });
    });
  }
}
