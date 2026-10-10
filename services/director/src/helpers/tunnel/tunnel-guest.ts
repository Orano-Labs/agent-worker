import { createServer as createHttp1Server, type Server as Http1Server } from "node:http";
import { createServer as createHttp2Server, type ServerHttp2Stream } from "node:http2";
import type { Socket } from "node:net";
import { createProxyMiddleware } from "http-proxy-middleware";
import { SocketPair } from "./socket-pair";

/**
 * The guest-side counterpart of `TunnelHost`.
 *
 * It maintains a pool of underlying transport sockets (one per connection),
 * obtained via `createConnection`. Each socket is handed to a cleartext HTTP/2
 * server as its transport. Every extended CONNECT stream received on that
 * server is bridged — via a `SocketPair` — into a fresh HTTP/1.1 connection
 * fed to an internal proxy, which routes it (using `router`) to a target inside
 * the guest.
 *
 * The pool is established on construction and kept alive for the lifetime of
 * the instance: whenever an underlying connection drops, it is re-established,
 * until `close()` is called.
 */
export class TunnelGuest {
  #router: (headers: Headers) => URL | Promise<URL>;
  #maxConnections: number;
  #createConnection: () => Socket | Promise<Socket>;

  #proxyServer: Http1Server;
  #http2Server: ReturnType<typeof createHttp2Server>;
  #pairs: SocketPair;

  #closed?: Promise<void>;
  #sockets = new Set<Socket>();

  constructor(options: TunnelGuest.Options) {
    this.#router = options.router;
    this.#maxConnections = options.maxConnections;
    this.#createConnection = options.createConnection;

    const proxy = createProxyMiddleware({
      ws: true,
      changeOrigin: true,
      router: async (req) => {
        const headers = new Headers();

        for (const [k, values] of Object.entries(req.headersDistinct)) {
          if (!values) continue;

          for (const v of values) {
            headers.append(k, v);
          }
        }

        return this.#router(headers);
      },
      on: {
        error: (_err, _req, res) => {
          if ("writeHead" in res) {
            if (!res.headersSent) {
              res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
              res.end("Failed to route request through tunnel (Tunnel Guest)");
            }
          } else {
            if (!res.closed) {
              try {
                const body = "Failed to route upgrade through tunnel (Tunnel Guest)";

                res.write(
                  `HTTP/1.1 502 Service Unavailable\r\n` +
                    `Content-Type: text/plain\r\n` +
                    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                    `Connection: close\r\n` +
                    `\r\n` +
                    body,
                );
              } catch {}

              res.destroy();
            }
          }
        },
      },
    });

    this.#proxyServer = createHttp1Server();

    this.#proxyServer.on("request", (req, res) => {
      proxy(req, res, (_) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          res.end("Failed to route request through tunnel (Tunnel Guest)");
        }
      });
    });

    this.#proxyServer.on("upgrade", (req, socket, head) => {
      // @ts-expect-error `socket`/`head` are compatible with the middleware's expectations.
      proxy.upgrade(req, socket, head);
    });

    this.#http2Server = createHttp2Server();

    // Advertise extended CONNECT (RFC 8441) so `:protocol` is accepted.
    this.#http2Server.on("session", (session) => {
      session.settings({ enableConnectProtocol: true });
    });

    this.#http2Server.on("stream", (stream, headers) => {
      this.#handleStream(stream as ServerHttp2Stream, headers);
    });

    this.#http2Server.on("sessionError", () => {});
    this.#http2Server.on("error", () => {});

    this.#pairs = new SocketPair();

    for (let i = 0; i < this.#maxConnections; i++) {
      this.#maintain();
    }
  }

  /**
   * Stops the pool: stops reconnecting, tears down any live transport sockets,
   * and releases the socket-pair file. Resolves once everything is closed.
   */
  async close() {
    if (this.#closed) {
      return this.#closed;
    }

    this.#closed = (async () => {
      for (const socket of this.#sockets) {
        socket.destroy();
      }

      this.#sockets.clear();

      await new Promise<void>((resolve) => this.#http2Server.close(() => resolve()));
      await new Promise<void>((resolve) => this.#proxyServer.close(() => resolve()));

      await this.#pairs.close();
    })();

    return this.#closed;
  }

  /**
   * Maintains a single connection slot: dials a transport socket, hands it to
   * the HTTP/2 server, and waits until it drops before dialing a replacement.
   */
  async #maintain() {
    while (!this.#closed) {
      let socket: Socket;

      try {
        socket = await this.#createConnection();
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      if (this.#closed || socket.destroyed) {
        socket?.destroy();
        return;
      }

      this.#sockets.add(socket);

      try {
        this.#http2Server.emit("connection", socket);
      } catch {
        socket.destroy();
        this.#sockets.delete(socket);
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      await new Promise<void>((resolve) => {
        const onClose = () => {
          socket.off("close", onClose);
          socket.off("error", onError);
          resolve();
        };

        // Errors are followed by a `close`; swallow to avoid an uncaught
        // exception, the `close` listener above completes the slot cycle.
        const onError = () => {};

        socket.once("close", onClose);
        socket.once("error", onError);
      });

      this.#sockets.delete(socket);

      if (this.#closed) {
        return;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    }
  }

  /**
   * Bridges an extended CONNECT stream into the proxy: creates a socket pair,
   * splices the stream to one side, and feeds the other side to the HTTP/1.1
   * server as if a fresh client connection had arrived.
   */
  async #handleStream(stream: ServerHttp2Stream, headers: Record<string, string | string[] | undefined>) {
    if (headers[":method"] !== "CONNECT") {
      stream.respond({ ":status": 405 });
      stream.end();
      return;
    }

    let pair: SocketPair.Pair;

    try {
      pair = await this.#pairs.create();
    } catch (error) {
      if (!stream.destroyed && !stream.closed) {
        stream.respond({ ":status": 500 });
        stream.end();
      }
      return;
    }

    const { client, server } = pair;

    // Pair creation is asynchronous; the stream may have closed meanwhile.
    if (stream.destroyed || stream.closed) {
      client.destroy();
      server.destroy();
      return;
    }

    let disposed = false;

    const dispose = (origin: "stream" | "pair", error?: Error) => {
      if (disposed) return;
      disposed = true;

      stream.off("error", onStreamError);
      client.off("error", onPairError);
      server.off("error", onPairError);

      stream.off("close", onStreamClose);
      client.off("close", onPairClose);
      server.off("close", onPairClose);

      // Stop forwarding in both directions.
      stream.unpipe(client);
      client.unpipe(stream);

      if (!client.destroyed) client.destroy(error);
      if (!server.destroyed) server.destroy(error);

      // Only destroy the HTTP/2 stream when the bridge failed or
      // a bridge socket closed while the stream itself was still alive.
      if (origin === "pair" && !stream.destroyed) {
        stream.destroy(error);
      }
    };

    const onStreamError = (error: Error) => dispose("stream", error);

    const onStreamClose = () => dispose("stream");

    const onPairError = (error: Error) => dispose("pair", error);

    const onPairClose = () => dispose("pair");

    // Install error handlers before responding or starting the pipes.
    stream.on("error", onStreamError);
    stream.once("close", onStreamClose);

    client.on("error", onPairError);
    client.once("close", onPairClose);

    server.on("error", onPairError);
    server.once("close", onPairClose);

    // Recheck after listener installation.
    if (stream.destroyed || stream.closed || client.destroyed || server.destroyed) {
      dispose(stream.destroyed || stream.closed ? "stream" : "pair");
      return;
    }

    try {
      stream.respond({ ":status": 200 });

      stream.pipe(client);
      client.pipe(stream);

      // Transfer ownership of the server-side socket to the HTTP/1 proxy.
      this.#proxyServer.emit("connection", server);
    } catch (error) {
      dispose("pair", error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export namespace TunnelGuest {
  export type Options = {
    router: (headers: Headers) => URL | Promise<URL>;
    maxConnections: number;
    createConnection: () => Socket | Promise<Socket>;
  };
}
