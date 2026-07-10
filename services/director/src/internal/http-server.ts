import { createServer } from "node:http";
import type { Socket } from "node:net";
import { default as Router } from "find-my-way";

import { Container } from "@/helpers/container";
import { Result } from "@/helpers/result";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

const SHUTDOWN_GRACE_MS = 5_000;

export class HTTPServer {
  #server: ReturnType<typeof createServer>;
  #router: Router.Instance<Router.HTTPVersion.V1>;
  #variables: Variables;
  #logger: Logger;
  #sockets: Set<Socket>;

  constructor() {
    this.#router = Router();
    this.#server = createServer(this.#router.lookup.bind(this.#router));
    this.#variables = Container.inject(Variables);
    this.#logger = Container.inject(Logger).scope("HTTPServer");
    this.#sockets = new Set();

    // Track open connections so shutdown can drain them.
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => {
        this.#sockets.delete(socket);
      });
    });
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
    return `http://127.0.0.1:${this.#variables.getNumber("AW_DIRECTOR_HTTP_PORT", 3008)}`;
  }

  /**
   * Gracefully shut down the HTTP server.
   *
   * 1. Stops accepting new connections via {@link server.close}.
   * 2. Waits up to {@link SHUTDOWN_GRACE_MS} for in-flight requests to complete.
   * 3. Force-destroys any remaining sockets.
   */
  async shutdown(): Promise<void> {
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
      }, SHUTDOWN_GRACE_MS);
    });

    await Promise.race([closed, timeout]);

    this.#logger.info("HTTP server shut down.");
  }

  async init(): Promise<Result<void, Error>> {
    const port = this.#variables.getNumber("AW_DIRECTOR_HTTP_PORT", 3008);

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
      return Result.error(new Error("Failed to start HTTP server.", { cause: error }));
    }

    return Result.ok();
  }
}
