import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { Duplex } from "node:stream";
import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { addRoute, createRouter, findRoute, MatchedRoute } from "rou3";

const SHUTDOWN_GRACE_MS = 5_000;

export class HTTPServer extends Container.ServiceConstructable {
  #environment: Environment;
  #server: ReturnType<typeof createServer>;
  #logger: Logger;
  #sockets: Set<Socket>;
  #router: HTTPServer.Router;

  constructor(...deps: [Environment, Logger]) {
    super();

    this.#environment = deps[0];
    this.#server = createServer();
    this.#logger = deps[1].namespace("Server");
    this.#sockets = new Set();

    // Track open connections so shutdown can drain them.
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => {
        this.#sockets.delete(socket);
      });
    });

    this.#router = new HTTPServer.Router(this.#server);
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

  get router() {
    return this.#router;
  }

  protected override async initialize(signal: AbortSignal) {
    if (signal.aborted) {
      throw signal.reason;
    }

    const port = this.#environment.getNumber("HTTP_PORT", 3008);

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.#server.off("listening", onListening);
          reject(error);
        };

        const onListening = () => {
          this.#server.off("error", onError);
          resolve();
        };

        this.#server.once("error", onError);
        this.#server.once("listening", onListening);
        this.#server.listen(port);
      });
    } catch (error) {
      throw new Error("Failed to start HTTP server.", { cause: error });
    }

    const endpoints = Object.values(networkInterfaces())
      .flatMap((ifaces) => ifaces ?? [])
      .filter((iface) => iface.family === "IPv4")
      .map((iface) => `http://${iface.address}:${port}`);

    this.#logger.info(`HTTP server is running on port ${port}.`, { endpoints });
  }

  protected override async dispose(_reason?: unknown) {
    if (!this.#server.listening) {
      return;
    }

    this.#logger.info("Shutting down HTTP server...");

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve();
      };

      // Give existing connections a grace period, then destroy them.
      const timer = setTimeout(() => {
        if (this.#sockets.size > 0) {
          this.#logger.warn("Force-closing remaining HTTP connections", {
            count: this.#sockets.size,
          });
        }

        for (const socket of this.#sockets) {
          socket.destroy();
        }

        finish();
      }, SHUTDOWN_GRACE_MS);

      this.#server.close(() => finish());
    });

    this.#logger.info("HTTP server shut down.");
  }
}

export namespace HTTPServer {
  export class Router {
    #server: ReturnType<typeof createServer>;
    #requestRouter: ReturnType<typeof createRouter<Router.RequestHandler>>;
    #upgradeRouter: ReturnType<typeof createRouter<Router.UpgradeHandler>>;

    constructor(server: ReturnType<typeof createServer>) {
      this.#server = server;

      this.#requestRouter = createRouter<Router.RequestHandler>();
      this.#upgradeRouter = createRouter<Router.UpgradeHandler>();

      this.#server.on("request", (req, res) => {
        const route = this.#find("request", req.method ?? "GET", req.url ?? "/");

        if (!route) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not Found");

          return;
        }

        route.data({
          req,
          res,
          params: route.params ?? {},
        });
      });

      this.#server.on("upgrade", (req, socket, head) => {
        const route = this.#find("upgrade", req.method ?? "GET", req.url ?? "/");

        if (!route) {
          socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");

          return;
        }

        route.data({
          req,
          socket,
          head,
          params: route.params ?? {},
        });
      });
    }

    #normalizeMethod(method: string) {
      const normalized = method.trim().toUpperCase();

      // rou3 uses an empty method to represent a route that matches every method.
      return normalized === "*" ? "" : normalized;
    }

    #normalizePath(path: string) {
      const query = path.indexOf("?");

      if (query !== -1) {
        path = path.slice(0, query);
      }

      const hash = path.indexOf("#");

      if (hash !== -1) {
        path = path.slice(0, hash);
      }

      return path;
    }

    request(method: Router.Method, path: string, handler: Router.RequestHandler) {
      addRoute(this.#requestRouter, this.#normalizeMethod(method), path, handler);

      return this;
    }

    upgrade(method: Router.Method, path: string, handler: Router.UpgradeHandler) {
      addRoute(this.#upgradeRouter, this.#normalizeMethod(method), path, handler);

      return this;
    }

    #find(mode: "request", method: string, path: string): MatchedRoute<Router.RequestHandler> | undefined;
    #find(mode: "upgrade", method: string, path: string): MatchedRoute<Router.UpgradeHandler> | undefined;
    #find(mode: Router.Mode, method: string, path: string) {
      const normalizedMethod = this.#normalizeMethod(method);
      const normalizedPath = this.#normalizePath(path);

      if (mode === "request") {
        return findRoute(this.#requestRouter, normalizedMethod, normalizedPath, { params: true, normalize: true });
      }

      return findRoute(this.#upgradeRouter, normalizedMethod, normalizedPath, { params: true, normalize: true });
    }
  }

  export namespace Router {
    export type Mode = "request" | "upgrade";

    export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "CONNECT" | "TRACE" | "*";

    export type RequestContext = {
      req: IncomingMessage;
      res: ServerResponse;
      params: Record<string, string>;
    };

    export type UpgradeContext = {
      req: IncomingMessage;
      socket: Duplex;
      head: Buffer;
      params: Record<string, string>;
    };

    export type RequestHandler = (context: RequestContext) => void | Promise<void>;

    export type UpgradeHandler = (context: UpgradeContext) => void | Promise<void>;
  }
}
