import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { addRoute, createRouter, findRoute, routesOverlap } from "rou3";

export class HTTPServer extends Container.ServiceConstructable {
  #server: ReturnType<typeof createServer>;
  #environment: Environment;
  #logger: Logger;
  #sockets: Set<Socket>;

  #requestRouter: ReturnType<typeof createRouter<HTTPServer.RequestRoute>>;
  #upgradeRouter: ReturnType<typeof createRouter<HTTPServer.UpgradeRoute>>;

  #registered: {
    kind: "request" | "upgrade";
    method: HTTPServer.Method;
    path: string;
  }[];

  constructor(...deps: [Environment, Logger]) {
    super();

    this.#server = createServer();
    this.#environment = deps[0];
    this.#logger = deps[1].namespace("HTTPServer");
    this.#sockets = new Set();
    this.#registered = [];

    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => {
        this.#sockets.delete(socket);
      });
    });

    this.#requestRouter = createRouter();
    this.#upgradeRouter = createRouter();

    this.#setupHandlers();
  }

  route(route: HTTPServer.Route) {
    const router = route.kind === "request" ? this.#requestRouter : this.#upgradeRouter;
    const methods = [] as HTTPServer.Method[];

    if (route.method !== HTTPServer.Method.Any) {
      methods.push(route.method);
    } else {
      methods.push(
        HTTPServer.Method.Get,
        HTTPServer.Method.Post,
        HTTPServer.Method.Put,
        HTTPServer.Method.Patch,
        HTTPServer.Method.Delete,
        HTTPServer.Method.Head,
        HTTPServer.Method.Options,
        HTTPServer.Method.Trace,
        HTTPServer.Method.Connect,
      );
    }

    for (const method of methods) {
      for (const other of this.#registered) {
        if (other.kind === route.kind && other.method === method && routesOverlap(other.path, route.path)) {
          this.#logger.warn("Route conflict detected", {
            method,
            path: route.path,
            conflictingPath: other.path,
          });
        }
      }

      addRoute(router, method, route.path, route);

      this.#registered.push({ kind: route.kind, method, path: route.path });
      this.#logger.info(`Registered route ${method.padStart(8, " ")}(${route.kind.toUpperCase()}) ${route.path}`);
    }

    return this;
  }

  #setupHandlers() {
    this.#server.on("request", (req, res) => {
      const method = req.method || "unknown";
      const route = findRoute(this.#requestRouter, method.toUpperCase(), req.url ?? "", {
        params: true,
        normalize: true,
      });

      if (!route) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Request route not found");

        return this.#logger.warn("Request route not found", { url: req.url });
      }

      route.data.handler({
        req,
        res,
        params: route.params || {},
      });
    });

    this.#server.on("upgrade", (req, socket, head) => {
      const method = req.method || "unknown";
      const route = findRoute(this.#upgradeRouter, method.toUpperCase(), req.url ?? "", {
        params: true,
        normalize: true,
      });

      if (!route) {
        const body = "Upgrade route not found";

        try {
          socket.write(
            `HTTP/1.1 404 Not Found\r\n` +
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

        return this.#logger.warn("Upgrade route not found", { url: req.url });
      }

      route.data.handler({
        req,
        socket,
        head,
        params: route.params || {},
      });
    });
  }

  get server() {
    if (!this.#server) {
      throw new Error("Server is not initialized.");
    }

    return this.#server;
  }

  get url() {
    return `http://127.0.0.1:${this.#environment.getNumber("HTTP_PORT", 3008)}`;
  }

  protected override async dispose() {
    this.#logger.info("Shutting down HTTP server...");

    // Stop accepting new connections.
    const closed = new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });

    // Give existing connections a grace period, then destroy them.
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.#sockets.size > 0) {
          this.#logger.warn("Force-closing remaining HTTP connections", {
            count: this.#sockets.size,
          });
        }

        for (const socket of this.#sockets) {
          socket.destroy();
        }

        resolve();
      }, HTTPServer.SHUTDOWN_GRACE_MS);
    });

    await Promise.race([closed, timeout]);

    this.#logger.info("HTTP server shut down.");
  }

  protected override async initialize(_: AbortSignal) {
    const port = this.#environment.getPort("HTTP_PORT", 3008);

    try {
      await new Promise<void>((resolve, reject) => {
        const callback = async () => {
          this.#logger.info(`HTTP server is running on port ${port}`);

          const os = await import("node:os");
          const interfaces = os.networkInterfaces();

          const endpoints: unknown[] = [];

          for (const [_, ifaces] of Object.entries(interfaces)) {
            if (!ifaces) continue;

            for (const iface of ifaces) {
              if (iface.family === "IPv4") {
                endpoints.push(`http://${iface.address}:${port}`);
              }
            }
          }

          this.#logger.info("Server is listening on all interfaces. Available endpoints:", {
            endpoints,
          });

          resolve();
        };

        this.#server.listen(port, callback);
        this.#server.on("error", reject);
      });
    } catch (error) {
      throw new Error("Failed to start HTTP server.", { cause: error });
    }
  }
}

export namespace HTTPServer {
  export enum Method {
    Get = "GET",
    Post = "POST",
    Put = "PUT",
    Patch = "PATCH",
    Delete = "DELETE",
    Head = "HEAD",
    Options = "OPTIONS",
    Trace = "TRACE",
    Connect = "CONNECT",
    Any = "*",
  }

  export type RequestRouteContext = {
    readonly req: IncomingMessage;
    readonly res: ServerResponse;
    readonly params: Record<string, string>;
  };

  export type UpgradeRouteContext = {
    readonly req: IncomingMessage;
    readonly socket: Duplex;
    readonly head: Buffer;
    readonly params: Record<string, string>;
  };

  export type RequestRoute = {
    kind: "request";
    method: Method;
    path: string;
    handler: (context: RequestRouteContext) => void;
  };

  export type UpgradeRoute = {
    kind: "upgrade";
    method: Method;
    path: string;
    handler: (context: UpgradeRouteContext) => void;
  };

  export type Route = RequestRoute | UpgradeRoute;

  export const SHUTDOWN_GRACE_MS = 5_000;
}
