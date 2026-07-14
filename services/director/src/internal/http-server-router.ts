import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { addRoute, createRouter, findRoute } from "rou3";
import { TunnelManager } from "@/core/tunnel-manager";
import { Container } from "@/helpers/container";
import { HTTPServer } from "@/internal/http-server";
import { Logger } from "@/internal/logger";

type UpgradeRouteContext = {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  params: Record<string, string>;
};

type UpgradeRoute = {
  handler: (context: UpgradeRouteContext) => void;
};

type RequestRouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
};

type RequestRoute = {
  handler: (context: RequestRouteContext) => void;
};

export class HTTPServerRouter {
  #http: HTTPServer;
  #logger: Logger;
  #upgradeRouter: ReturnType<typeof createRouter<UpgradeRoute>>;
  #requestRouter: ReturnType<typeof createRouter<RequestRoute>>;
  #tunnels: TunnelManager;

  constructor() {
    this.#http = Container.inject(HTTPServer);
    this.#logger = Container.inject(Logger).scope("HTTPServerRouter");
    this.#upgradeRouter = createRouter();
    this.#requestRouter = createRouter();
    this.#tunnels = Container.inject(TunnelManager);
  }

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

  #handleTunnelUpgrade(context: UpgradeRouteContext) {
    // TODO: Auth

    const project = context.params.project;
    const token = context.params.token;

    const error = this.#tunnels.createTunnelConnection(project, token, context.socket);

    if (error) {
      this.#respond(context.socket, error.status, error.message);

      return;
    }

    // Complete the upgrade handshake so the client knows it succeeded.
    context.socket.write("HTTP/1.1 101 Switching Protocols\r\n" + "Upgrade: tunnel\r\n" + "Connection: Upgrade\r\n" + "\r\n");
  }

  #handleClientRequest(context: RequestRouteContext) {}

  #handleClientUpgrade(context: UpgradeRouteContext) {}

  setup() {
    addRoute(this.#upgradeRouter, "UPGRADE", "tunnel/:project/:token", {
      handler: (ctx) => this.#handleTunnelUpgrade(ctx),
    });

    this.#http.server.on("upgrade", (req, socket, head) => {
      const route = findRoute(this.#upgradeRouter, "UPGRADE", req.url ?? "", {
        params: true,
        normalize: true,
      });

      if (!route) {
        return this.#respond(socket, 404, "Not Found.");
      }

      route.data.handler({
        req,
        socket,
        head,
        params: route.params || {},
      });
    });

    this.#http.server.on("request", (req, res) => {
      const route = findRoute(this.#requestRouter, "ALL", req.url ?? "", {
        params: true,
        normalize: true,
      });

      if (!route) {
        // xxx
        //
        return;
      }

      route.data.handler({
        req,
        res,
        params: route.params || {},
      });
    });
  }
}
