import { Server as HTTPServer } from "node:http";
import { Socket } from "node:net";
import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { default as Router } from "find-my-way";

export class Server extends Container.ServiceConstructable {
  #router: Router.Instance<Router.HTTPVersion.V1>;
  #server: HTTPServer;

  #connections: Map<Socket, number>;
  #shuttingDown: boolean;

  #logger: Logger;
  #environment: Environment;

  #cachedHost?: string;
  #cachedPort?: number;

  constructor(...deps: [Environment, Logger]) {
    super();

    this.#router = Router();
    this.#server = new HTTPServer();

    this.#connections = new Map();
    this.#shuttingDown = false;

    this.#logger = deps[1].namespace("Server");
    this.#environment = deps[0];
  }

  get #host() {
    if (this.#cachedHost === undefined) {
      this.#cachedHost = this.#environment.getHost("SERVER_HOST") || "";
    }

    return this.#cachedHost;
  }

  get #port() {
    if (this.#cachedPort === undefined) {
      this.#cachedPort = this.#environment.getPort("SERVER_PORT") || 3000;
    }

    return this.#cachedPort;
  }

  get router() {
    return this.#router;
  }

  get server() {
    return this.#server;
  }

  #setupConnectionTracking() {
    const onConnection = (socket: Socket) => {
      this.#connections.set(socket, 0);

      socket.on("close", () => {
        this.#connections.delete(socket);
      });
    };

    this.server.on("connection", onConnection);
    this.server.on("secureConnection", onConnection);

    this.server.on("request", (req, res) => {
      const socket = req.socket;
      const current = this.#connections.get(socket) || 0;

      this.#connections.set(socket, current + 1);

      res.on("finish", () => {
        const previous = this.#connections.get(socket) || 0;
        const updated = Math.max(0, previous - 1);

        this.#connections.set(socket, updated);

        // Intercept and check if this socket can be safely destroyed.
        // If the server is shutting down and this was the last pending request on the Keep-Alive channel,
        // the socket will be safely disconnected right here.
        this.#destroyConnection(socket);
      });
    });
  }

  #setupRouter() {
    this.server.on("request", (req, res) => {
      this.#router.lookup(req, res);
    });
  }

  #destroyConnection(socket: Socket, force?: boolean) {
    const requests = this.#connections.get(socket) || 0;

    // A connection is destroyed under two scenarios:
    // 1. It is a forced shutdown (force === true)
    // 2. The server is gracefully shutting down AND the socket has no pending active requests (requests === 0)
    if (force || (this.#shuttingDown && requests === 0)) {
      socket.destroy();
      this.#connections.delete(socket);
    }
  }

  override async initialize(_signal: AbortSignal) {
    try {
      await new Promise<void>((resolve, reject) => {
        const callback = async () => {
          this.#logger.info(`HTTP server is running on port ${this.#port}`);

          if (this.#host) {
            this.#logger.info(`Server is explicitly bound to host: http://${this.#host}:${this.#port}`);
          } else {
            const os = await import("node:os");
            const interfaces = os.networkInterfaces();

            const endpoints: unknown[] = [];

            for (const [_, ifaces] of Object.entries(interfaces)) {
              if (!ifaces) continue;

              for (const iface of ifaces) {
                if (iface.family === "IPv4") {
                  endpoints.push(`http://${iface.address}:${this.#port}`);
                }
              }
            }

            this.#logger.info("Server is listening on all interfaces. Available endpoints:", {
              endpoints,
            });
          }

          resolve();
        };

        if (this.#host) {
          this.#server.listen(this.#port, this.#host, callback);
        } else {
          this.#server.listen(this.#port, callback);
        }

        this.#server.on("error", reject);
      });
    } catch (error) {
      throw new Error("Failed to start HTTP server.", { cause: error });
    }

    this.#setupConnectionTracking();
    this.#setupRouter();
  }

  override async dispose() {
    if (this.#shuttingDown) {
      return;
    }

    this.#shuttingDown = true;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#logger.warn("Graceful shutdown timed out. Forcing destruction of remaining connections.");

        for (const socket of [...this.#connections.keys()]) {
          this.#destroyConnection(socket, true);
        }
      }, 3000);

      // Stop accepting new incoming TCP connections and wait for pre-existing requests to finish naturally
      this.server.close((err) => {
        clearTimeout(timer);

        if (err) {
          this.#logger.error("An error occurred while closing the HTTP server.", { err });
        } else {
          this.#logger.info("HTTP server has been closed successfully and safely.");
        }

        resolve();
      });

      // Instantly scan and cull all existing connections that are completely "Idle" (counter === 0)
      // at the exact moment the shutdown command is issued.
      for (const socket of [...this.#connections.keys()]) {
        this.#destroyConnection(socket);
      }
    });
  }
}
