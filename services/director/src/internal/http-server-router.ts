import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { addRoute, createRouter, findRoute } from "rou3";
import { TunnelManager } from "@/core/tunnel-manager";
import { Container } from "@/helpers/container";
import { Authenticator } from "@/internal/authenticator";
import { HTTPServer } from "@/internal/http-server";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";

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
  #auth: Authenticator;
  #repository: Repository;

  constructor() {
    this.#http = Container.inject(HTTPServer);
    this.#logger = Container.inject(Logger).scope("HTTPServerRouter");
    this.#upgradeRouter = createRouter();
    this.#requestRouter = createRouter();
    this.#tunnels = Container.inject(TunnelManager);
    this.#auth = Container.inject(Authenticator);
    this.#repository = Container.inject(Repository);
  }

  /** Map numeric status to standard HTTP reason phrase. */
  #reason(status: number): string {
    switch (status) {
      case 400:
        return "Bad Request";
      case 401:
        return "Unauthorized";
      case 403:
        return "Forbidden";
      case 404:
        return "Not Found";
      case 502:
        return "Bad Gateway";
      case 503:
        return "Service Unavailable";
      default:
        return "Error";
    }
  }

  /** Write an HTTP response directly onto a Duplex (used for upgrade paths). */
  #respond(socket: Duplex, status: number, message: string) {
    const reason = this.#reason(status);
    const body = message;

    try {
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\n` +
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

  /** Shortcut for request-path error responses on `ServerResponse`. */
  #error(res: ServerResponse, status: number, message: string) {
    res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(message);
  }

  /** Parse request headers into a Headers object for the authenticator. */
  #toHeaders(req: IncomingMessage): Headers {
    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;

      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }

    return headers;
  }

  async #handleTunnelUpgrade(context: UpgradeRouteContext) {
    const projectId = context.params.project;
    const token = context.params.token;

    // Authenticate — only supervisors may join a tunnel pool.
    let identity: Authenticator.Identity;

    try {
      identity = await this.#auth.authenticate(this.#toHeaders(context.req));
    } catch {
      this.#respond(context.socket, 401, "Authentication required");

      return;
    }

    if (identity.case !== "supervisor") {
      this.#respond(context.socket, 403, "Only supervisors can establish tunnel connections");

      return;
    }

    // Verify the project exists and belongs to this supervisor.
    const project = await this.#repository.client.project.findFirst({
      where: {
        id: projectId,
        ownerId: identity.supervisorId,
      },
    });

    if (!project) {
      this.#respond(context.socket, 404, `Project "${projectId}" not found or not owned by this supervisor`);

      return;
    }

    const error = this.#tunnels.createTunnelConnection(projectId, token, context.socket);

    if (error) {
      this.#respond(context.socket, error.status, error.message);

      return;
    }

    // Complete the upgrade handshake so the client knows it succeeded.
    context.socket.write("HTTP/1.1 101 Switching Protocols\r\n" + "Upgrade: tunnel\r\n" + "Connection: Upgrade\r\n" + "\r\n");
  }

  async #handleClientRequest(context: RequestRouteContext) {
    const projectId = context.params.project;
    const path = context.params.rest;

    // Authenticate — only project owners may send requests.
    let identity: Authenticator.Identity;

    try {
      identity = await this.#auth.authenticate(this.#toHeaders(context.req));
    } catch {
      this.#error(context.res, 401, "Authentication required");

      return;
    }

    if (identity.case !== "user") {
      this.#error(context.res, 403, "Only users can send requests to projects");

      return;
    }

    // Verify the project exists and belongs to this user.
    const project = await this.#repository.client.project.findFirst({
      where: {
        id: projectId,
        ownerId: identity.userId,
      },
    });

    if (!project) {
      this.#error(context.res, 404, `Project "${projectId}" not found or not owned by you`);

      return;
    }

    const tunnel = this.#tunnels.get(projectId);

    if (!tunnel) {
      this.#error(context.res, 404, `Project "${projectId}" is not connected`);

      return;
    }

    this.#stripAuthHeaders(context.req);
    tunnel.handleHttpRequest(context.req, context.res, path);
  }

  async #handleClientUpgrade(context: UpgradeRouteContext) {
    const projectId = context.params.project;
    const path = context.params.rest;

    // Authenticate — only project owners may open upgrade streams.
    let identity: Authenticator.Identity;

    try {
      identity = await this.#auth.authenticate(this.#toHeaders(context.req));
    } catch {
      this.#respond(context.socket, 401, "Authentication required");

      return;
    }

    if (identity.case !== "user") {
      this.#respond(context.socket, 403, "Only users can open upgrade streams to projects");

      return;
    }

    // Verify the project exists and belongs to this user.
    const project = await this.#repository.client.project.findFirst({
      where: {
        id: projectId,
        ownerId: identity.userId,
      },
    });

    if (!project) {
      this.#respond(context.socket, 404, `Project "${projectId}" not found or not owned by you`);

      return;
    }

    const tunnel = this.#tunnels.get(projectId);

    if (!tunnel) {
      this.#respond(context.socket, 404, `Project "${projectId}" is not connected`);

      return;
    }

    this.#stripAuthHeaders(context.req);
    tunnel.handleHttpUpgrade(context.req, context.socket, context.head, path);
  }

  /** Remove auth headers from the request before forwarding to the tunnel. */
  #stripAuthHeaders(req: IncomingMessage): void {
    /** Auth-related headers that must be stripped before forwarding to the tunnel. */
    const authHeaders = ["x-request-signature", "x-request-signature-development"];

    for (const name of authHeaders) {
      delete req.headers[name];
    }
  }

  setup() {
    addRoute(this.#upgradeRouter, "UPGRADE", "tunnel/:project/:token", {
      handler: (ctx) => this.#handleTunnelUpgrade(ctx),
    });

    addRoute(this.#upgradeRouter, "UPGRADE", "link/:project/**:rest", {
      handler: (ctx) => this.#handleClientUpgrade(ctx),
    });

    addRoute(this.#requestRouter, "ALL", "link/:project/**:rest", {
      handler: (ctx) => this.#handleClientRequest(ctx),
    });

    this.#http.server.on("upgrade", (req, socket, head) => {
      const route = findRoute(this.#upgradeRouter, "UPGRADE", req.url ?? "", {
        params: true,
        normalize: true,
      });

      if (!route) {
        return this.#respond(socket, 404, "Upgrade route not found");
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
        this.#error(res, 404, "Route not found");

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
