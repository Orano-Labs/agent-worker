import { request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { default as pump } from "pump";

export class TunnelClient {
  #target: URL;
  #started: boolean;
  #baseUrl: string;
  #project: string;
  #token: string;
  #maxSockets: number;
  #logger: TunnelClient.Logger;

  constructor(options: TunnelClient.Options) {
    this.#baseUrl = options.baseUrl;
    this.#target = options.target;
    this.#started = false;
    this.#project = options.project;
    this.#token = options.token;
    this.#maxSockets = options.maxSockets;
    this.#logger = options.logger;
  }

  start(signal: AbortSignal) {
    signal.throwIfAborted();

    if (this.#started) {
      throw new Error("TunnelClient is already started");
    }

    this.#started = true;

    for (let i = 0; i < this.#maxSockets; i++) {
      this.#createTunnelSocket(signal);
    }
  }

  async #createTunnelSocket(signal: AbortSignal) {
    const target = this.#resolveTarget();

    while (!signal.aborted) {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const url = new URL(`${this.#baseUrl}/tunnel/${this.#project}/${this.#token}`);
        const request = httpRequest(url, {
          headers: {
            connection: "upgrade",
            upgrade: "tunnel",
          },
        });

        request.on("upgrade", (_, socket) => {
          resolve(socket);
        });

        request.on("error", (error) => {
          reject(error);
        });

        request.on("response", (resp) => {
          reject(new Error(`Tunnel upgrade rejected: ${resp.statusCode} ${resp.statusMessage}`));
        });

        request.end();
      }).catch((error) => {
        this.#logger.warn("Tunnel connection failed, retrying in 1s", {
          project: this.#project,
          error: String(error),
        });

        return new Promise<void>((resolve) => {
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          const onTimeout = () => {
            signal.removeEventListener("abort", onAbort);
          };
          const timer = setTimeout(onTimeout, 1000);

          signal.addEventListener("abort", onAbort, { once: true });
        });
      });

      if (!socket) {
        continue;
      }

      this.#logger.info("Tunnel socket connected", {
        project: this.#project,
      });

      socket.setKeepAlive(true);

      socket.once("data", (chunk) => {
        const remote = target.tls
          ? tlsConnect({
              host: target.hostname,
              port: target.port,
              servername: target.hostname,
              rejectUnauthorized: false,
            })
          : netConnect({ host: target.hostname, port: target.port });

        remote.on("data", (chunk) => {
          console.log(chunk.toString());
        });

        remote.once("connect", () => {
          const data = chunk.toString().replace(/(\r\n[Hh]ost: )\S+/, (_, $1: string) => {
            return $1 + target.hostname;
          });

          console.log(data);

          remote.write(data);

          pump(socket, remote);
          pump(remote, socket);
        });

        remote.once("error", (error) => {
          this.#logger.error("Remote connection error", {
            project: this.#project,
            error: String(error),
          });

          socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          socket.destroy(error);
        });
      });

      // Wait for this socket to close before reconnecting.
      await new Promise<void>((resolve) => {
        const cleanup = () => {
          socket.removeListener("close", onClose);
          socket.removeListener("error", onError);
          signal.removeEventListener("abort", onAbort);
        };

        const onClose = () => {
          cleanup();
          resolve();
        };

        const onError = () => {
          socket.destroy();
          cleanup();
          resolve();
        };

        const onAbort = () => {
          if (!socket.destroyed) {
            socket.destroy();
          }
          cleanup();
          resolve();
        };

        socket.once("close", onClose);
        socket.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  #resolveTarget(): { hostname: string; port: number; tls: boolean } {
    const protocol = this.#target.protocol.replace(":", "");

    return {
      hostname: this.#target.hostname,
      port: this.#target.port ? Number.parseInt(this.#target.port, 10) : protocol === "https" ? 443 : 80,
      tls: protocol === "https",
    };
  }
}

export namespace TunnelClient {
  export type Logger = {
    [k in "info" | "warn" | "error" | "debug"]: (message: string, context: Record<string, unknown>) => void;
  };

  export type Options = {
    baseUrl: string;
    project: string;
    token: string;
    target: URL;
    logger: Logger;
    maxSockets: number;
  };
}
