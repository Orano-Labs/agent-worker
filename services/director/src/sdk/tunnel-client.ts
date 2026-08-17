import { createServer, request as httpRequest } from "node:http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { RequestSigner } from "./request-signer";

export class TunnelClient {
  #targetResolver: (headers: Headers) => URL | Promise<URL>;
  #started: boolean;
  #baseUrl: string;
  #maxConnections: number;
  #logger: TunnelClient.Logger;
  #signer: RequestSigner;
  #dummyServer: ReturnType<typeof createServer>;

  constructor(options: TunnelClient.Options) {
    this.#baseUrl = options.baseUrl;
    this.#targetResolver = options.targetResolver;
    this.#started = false;
    this.#maxConnections = options.maxConnections;
    this.#logger = options.logger;
    this.#signer = new RequestSigner(options.identity, options.dev ?? false);

    const proxy = createProxyMiddleware({
      ws: true,
      router: async (req) => {
        const headers = new Headers();

        for (const [k, values] of Object.entries(req.headersDistinct)) {
          if (!values) continue;
          for (const v of values) {
            headers.append(k, v);
          }
        }

        return this.#targetResolver(headers);
      },
    });

    this.#dummyServer = createServer(proxy);

    // The middleware only subscribes to 'upgrade' after a regular request has
    // passed through it. Since the tunnel may receive a WebSocket handshake as
    // its very first frame, forward upgrade events to the proxy explicitly.
    this.#dummyServer.on("upgrade", (req, socket, head) => {
      // @ts-expect-error
      proxy.upgrade(req, socket, head);
    });
  }

  start(signal: AbortSignal) {
    signal.throwIfAborted();

    if (this.#started) {
      throw new Error("TunnelClient is already started");
    }

    this.#started = true;

    for (let i = 0; i < this.#maxConnections; i++) {
      this.#createTunnelConnection(signal);
    }
  }

  async #sleep(signal: AbortSignal, delay: number) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        return resolve();
      }

      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      const onTimeout = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };

      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(onTimeout, delay);
    });
  }

  async #createTunnelConnection(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const headers = await this.#signer.apply(
          new Headers({
            connection: "upgrade",
            upgrade: "tunnel",
          }),
        );

        const socket = await new Promise<NodeJS.Socket>((resolve, reject) => {
          const request = httpRequest(new URL(`${this.#baseUrl}/tunnel`), {
            headers: Object.fromEntries(headers.entries()),
            signal,
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
        });

        this.#logger.info("Tunnel socket connected", {});

        await new Promise<void>((resolve) => {
          this.#dummyServer.emit("connection", socket);

          const cleanup = () => {
            socket.removeListener("close", cleanup);
            socket.removeListener("error", cleanup);
            signal.removeEventListener("abort", onAbort);
            resolve();
          };

          const onAbort = () => {
            // @ts-expect-error
            socket.destroy(new Error("Aborted."));
          };

          socket.addListener("close", cleanup);
          socket.addListener("error", cleanup);

          signal.addEventListener("abort", onAbort, { once: true });

          if (signal.aborted) {
            onAbort();
          }
        });
      } catch (err) {
        if (signal.aborted) break;

        this.#logger.warn("Tunnel connection failed, retrying in 2s", {
          err,
        });

        await this.#sleep(signal, 2000);
      }
    }
  }
}

export namespace TunnelClient {
  export type Logger = {
    [k in "info" | "warn" | "error" | "debug"]: (message: string, context: Record<string, unknown>) => void;
  };

  export type Options = {
    baseUrl: string;
    identity: RequestSigner.Identity;
    dev?: boolean;
    targetResolver: (headers: Headers) => URL | Promise<URL>;
    logger: Logger;
    maxConnections: number;
  };
}
