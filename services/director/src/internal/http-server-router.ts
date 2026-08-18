import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { addRoute, createRouter, findRoute } from "rou3";

import { Container } from "@/helpers/container";
import { Allocator } from "@/internal/allocator";
import { Authenticator } from "@/internal/authenticator";
import { GRPCServer } from "@/internal/grpc-server";
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

type ClientRouteContext = ({ kind: "request" } & RequestRouteContext) | ({ kind: "upgrade" } & UpgradeRouteContext);

export class HTTPServerRouter {
  #http: HTTPServer;
  #upgradeRouter: ReturnType<typeof createRouter<UpgradeRoute>>;
  #requestRouter: ReturnType<typeof createRouter<RequestRoute>>;
  #auth: Authenticator;
  #repository: Repository;
  #logger: Logger;
  #allocator: Allocator;
  #grpc: GRPCServer;

  constructor() {
    this.#http = Container.inject(HTTPServer);
    this.#upgradeRouter = createRouter();
    this.#requestRouter = createRouter();
    this.#auth = Container.inject(Authenticator);
    this.#repository = Container.inject(Repository);
    this.#logger = Container.inject(Logger).scope("Router");
    this.#allocator = Container.inject(Allocator);
    this.#grpc = Container.inject(GRPCServer);
  }

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
      case 500:
        return "Internal Server Error";
      case 502:
        return "Bad Gateway";
      case 503:
        return "Service Unavailable";
      default:
        return "Error";
    }
  }

  #respond(socket: Duplex, status: number, message: string) {
    this.#logger.warn("Rejecting connection", { status, message });

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

  #error(res: ServerResponse, status: number, message: string) {
    this.#logger.warn("Rejecting request", { status, message });

    res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(message);
  }

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

  #doTunnelUpgrade(supervisorId: string, socket: Duplex) {
    const lease = this.#allocator.getLease(supervisorId);

    if (!lease) {
      this.#logger.warn("Rejecting tunnel upgrade — supervisor is not online", {
        supervisorId,
      });

      return this.#respond(socket, 503, "Tunnel service is unavailable");
    }

    const error = lease.tunnel.connect(socket);

    if (error) {
      this.#logger.warn("Tunnel connection rejected", {
        supervisorId,
        status: error.status,
        message: error.message,
      });

      return this.#respond(socket, error.status, error.message);
    }

    this.#logger.debug("Tunnel connection established", {
      supervisorId,
    });

    socket.write("HTTP/1.1 101 Switching Protocols\r\n" + "Upgrade: tunnel\r\n" + "Connection: Upgrade\r\n" + "\r\n");
  }

  #reject(context: ClientRouteContext, status: number, message: string) {
    if (context.kind === "request") {
      return this.#error(context.res, status, message);
    }

    return this.#respond(context.socket, status, message);
  }

  #doClient(context: ClientRouteContext, projectId: string, path: string) {
    this.#logger.debug(`Forwarding client ${context.kind} to instance`, { projectId, method: context.req.method, path });

    this.#allocator
      .allocate(projectId)
      .then((result) => {
        const lease = this.#allocator.getLease(result.supervisor);

        if (!lease) {
          this.#logger.warn("Allocated supervisor has no lease", { projectId, supervisor: result.supervisor });

          return this.#reject(context, 503, "Project instance is unavailable");
        }

        this.#prepareRoutingHeaders(context.req, projectId);

        this.#logger.debug(`Routing ${context.kind} through tunnel`, { projectId, supervisor: result.supervisor, path });

        if (context.kind === "request") {
          lease.tunnel.handleHttpRequest(context.req, context.res, path);
        } else {
          lease.tunnel.handleHttpUpgrade(context.req, context.socket, context.head, path);
        }
      })
      .catch((error) => {
        const { status, message } = this.#formatAllocateError(error);

        this.#logger.warn(`Failed to allocate instance for client ${context.kind}`, { projectId, status, err: error });

        return this.#reject(context, status, message);
      });
  }

  #formatAllocateError(error: unknown) {
    if (error instanceof Allocator.AllocateError) {
      switch (error.code) {
        case Allocator.AllocateError.Code.Exhausted:
          return { status: 502, message: "Project instance allocation failed" };
        case Allocator.AllocateError.Code.NoCapacity:
          return { status: 503, message: "Insufficient system resources" };
        case Allocator.AllocateError.Code.NoSupervisor:
          return { status: 503, message: "No system resources available" };
      }
    }

    return { status: 500, message: "Internal server error" };
  }

  async #handleTunnelUpgrade(context: UpgradeRouteContext) {
    // Authenticate — only supervisors may join a tunnel pool.
    let identity: Authenticator.Identity;

    try {
      identity = await this.#auth.authenticate(this.#toHeaders(context.req));
    } catch (error) {
      this.#logger.warn("Tunnel upgrade authentication failed", { err: error });

      return this.#respond(context.socket, 401, "Authentication required");
    }

    if (identity.case !== "supervisor") {
      this.#logger.warn("Tunnel upgrade rejected — identity is not a supervisor", { case: identity.case });

      return this.#respond(context.socket, 403, "Only supervisors can establish tunnel connections");
    }

    this.#doTunnelUpgrade(identity.supervisorId, context.socket);
  }

  async #handleClient(context: ClientRouteContext) {
    const projectId = context.params.project;
    const path = context.params.rest;

    this.#logger.debug(`Client ${context.kind} received`, {
      method: context.req.method,
      projectId,
      path,
    });

    // Authenticate — only project owners may access their projects.
    let identity: Authenticator.Identity;

    try {
      identity = await this.#auth.authenticate(this.#toHeaders(context.req));
    } catch (error) {
      this.#logger.warn(`Client ${context.kind} authentication failed`, {
        projectId,
        err: error,
      });

      return this.#reject(context, 401, "Authentication required");
    }

    if (identity.case !== "user") {
      this.#logger.warn(`Client ${context.kind} rejected — identity is not a user`, {
        projectId,
        case: identity.case,
      });

      return this.#reject(context, 403, "Only users can access projects");
    }

    // Verify the project exists and belongs to this user.
    const project = await this.#repository.client.project.findFirst({
      where: {
        id: projectId,
        ownerId: identity.userId,
        deleteTime: null,
      },
    });

    if (!project) {
      this.#logger.warn("Project not found or not owned by user", {
        projectId,
        userId: this.#logger.mask(identity.userId),
      });

      return this.#reject(context, 404, `Project "${projectId}" not found or not owned by you`);
    }

    this.#doClient(context, projectId, `/${path}`);
  }

  async #handleGrpcRequest(context: Extract<ClientRouteContext, { kind: "request" }>) {
    this.#grpc.handler(context.req, context.res);
  }

  #prepareRoutingHeaders(req: IncomingMessage, projectId: string) {
    // Strip authentication headers so the upstream instance never sees them.
    const authHeaders = ["x-request-signature", "x-request-signature-development"];

    for (const name of authHeaders) {
      delete req.headers[name];
    }

    req.headers["x-project-id"] = projectId;
  }

  setup() {
    addRoute(this.#upgradeRouter, "UPGRADE", "tunnel", {
      handler: (ctx) => this.#handleTunnelUpgrade(ctx),
    });

    addRoute(this.#upgradeRouter, "UPGRADE", "link/:project/**:rest", {
      handler: (ctx) => this.#handleClient({ ...ctx, kind: "upgrade" }),
    });

    addRoute(this.#requestRouter, "ALL", "link/:project/**:rest", {
      handler: (ctx) => this.#handleClient({ ...ctx, kind: "request" }),
    });

    addRoute(this.#requestRouter, "ALL", "grpc/**:rest", {
      handler: (ctx) => this.#handleGrpcRequest({ ...ctx, kind: "request" }),
    });

    this.#http.server.on("upgrade", (req, socket, head) => {
      const route = findRoute(this.#upgradeRouter, "UPGRADE", req.url ?? "", {
        params: true,
        normalize: true,
      });

      if (!route) {
        this.#logger.warn("Upgrade route not found", { url: req.url });

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
        this.#logger.warn("Request route not found", { url: req.url });

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
