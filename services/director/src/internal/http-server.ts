import { readFile } from "node:fs/promises";
import { createSecureServer } from "node:http2";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import { default as Router } from "find-my-way";
import { Container } from "@/helpers/container";
import { Result } from "@/helpers/result";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

export class HTTPServer {
  #server?: ReturnType<typeof createSecureServer>;
  #router: Router.Instance<Router.HTTPVersion.V2>;
  #variables: Variables;
  #logger: Logger;

  /**
   * Map tracking active TCP connections and their concurrent request counts.
   * * [Key/Value]
   * - Key:   Socket (the TCP connection channel)
   * - Value: number (count of active HTTP requests currently processing)
   * * [Lifecycle States]
   * 1. 'connection' -> Add socket to Map with counter = 0 (Idle).
   * 2. 'request'    -> Increment counter (+1) -> Connection is Active.
   * 3. 'finish'     -> Decrement counter (-1) -> If 0, returns to Idle. Destroys if shutting down.
   * 4. 'close'      -> Remove socket from Map to prevent memory leaks.
   */
  #connections: Map<Socket, number>;
  #shuttingDown: boolean;

  constructor() {
    this.#router = Router();
    this.#variables = Container.inject(Variables);
    this.#logger = Container.inject(Logger).scope("HTTPServer");

    this.#connections = new Map();
    this.#shuttingDown = false;
  }

  get router() {
    return this.#router;
  }

  get server() {
    if (!this.#server) {
      throw new Error("Server is not initialized.");
    }

    return this.#server;
  }

  get url() {
    return `http://${this.#variables.get("AW_DIRECTOR_HTTP_HOST") || "127.0.0.1"}:${this.#variables.getNumber("AW_DIRECTOR_HTTP_PORT", 3008)}`;
  }

  #destroy(socket: Socket, force?: boolean) {
    const requests = this.#connections.get(socket) || 0;

    // A connection is destroyed under two scenarios:
    // 1. It is a forced shutdown (force === true)
    // 2. The server is gracefully shutting down AND the socket has no pending active requests (requests === 0)
    if (force || (this.#shuttingDown && requests === 0)) {
      socket.destroy();
      this.#connections.delete(socket);
    }
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
        this.#destroy(socket);
      });
    });
  }

  #setupRouter() {
    this.server.on("request", (req, res) => {
      this.#router.lookup(req, res);
    });
  }

  async shutdown() {
    if (this.#shuttingDown) {
      return;
    }

    this.#shuttingDown = true;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#logger.warn("Graceful shutdown timed out. Forcing destruction of remaining connections.");

        for (const socket of [...this.#connections.keys()]) {
          this.#destroy(socket, true);
        }
      }, 3000);

      // Stop accepting new incoming TCP connections and wait for pre-existing requests to finish naturally
      this.server.close((err) => {
        clearTimeout(timer);

        if (err) {
          this.#logger.errorFrom(err, "An error occurred while closing the HTTP server.");
        } else {
          this.#logger.info("HTTP server has been closed successfully and safely.");
        }

        resolve();
      });

      // Instantly scan and cull all existing connections that are completely "Idle" (counter === 0)
      // at the exact moment the shutdown command is issued.
      for (const socket of [...this.#connections.keys()]) {
        this.#destroy(socket);
      }
    });
  }

  async init(): Promise<Result<void, Error>> {
    const port = this.#variables.getNumber("AW_DIRECTOR_HTTP_PORT", 3008);
    const host = this.#variables.get("AW_DIRECTOR_HTTP_HOST");

    const keyFile = this.#variables.get("AW_DIRECTOR_GRPC_CA_KEY");
    const certFile = this.#variables.get("AW_DIRECTOR_GRPC_CA_CERTIFICATE");

    if (!keyFile || !certFile) {
      return Result.error(new Error("GRPC_CA_KEY and GRPC_CA_CERTIFICATE must be set to enable http2."));
    }

    const keyPath = resolve(keyFile);
    const certPath = resolve(certFile);

    let key: string;
    let cert: string;

    try {
      key = await readFile(keyPath, "utf-8");
      cert = await readFile(certPath, "utf-8");
    } catch (error) {
      return Result.error(new Error("Failed to read key or cert file.", { cause: error }));
    }

    const server = createSecureServer({
      key,
      cert,
      allowHTTP1: true,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const callback = async () => {
          this.#logger.info(`HTTP server is running on port ${port}`);

          if (host) {
            this.#logger.info(`Server is explicitly bound to host: http://${host}:${port}`);
          } else {
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
          }

          resolve();
        };

        if (host) {
          server.listen(port, host, callback);
        } else {
          server.listen(port, callback);
        }

        server.on("error", reject);
      });
    } catch (error) {
      return Result.error(new Error("Failed to start HTTP server.", { cause: error }));
    }

    this.#server = server;

    this.#setupConnectionTracking();
    this.#setupRouter();

    return Result.ok();
  }
}
