import { createServer as createHttp2Server, type ServerHttp2Stream } from "node:http2";
import type { Socket } from "node:net";

export class TunnelGuest {
  #router: (router: ServerHttp2Stream) => void;
  #maxConnections: number;
  #createConnection: () => Socket | Promise<Socket>;

  #http2Server: ReturnType<typeof createHttp2Server>;

  #closed?: Promise<void>;
  #sockets = new Set<Socket>();

  constructor(options: TunnelGuest.Options) {
    this.#router = options.router;
    this.#maxConnections = options.maxConnections;
    this.#createConnection = options.createConnection;

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

    const dispose = (error?: Error) => {
      stream.off("error", dispose);
      stream.off("close", dispose);

      if (!stream.destroyed) {
        stream.destroy(error);
      }
    };

    stream.once("error", dispose);
    stream.once("close", dispose);

    stream.respond({ ":status": 200 });

    try {
      this.#router(stream);
    } catch (error) {
      dispose(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export namespace TunnelGuest {
  export type Options = {
    router: (stream: ServerHttp2Stream) => void;
    maxConnections: number;
    createConnection: () => Socket | Promise<Socket>;
  };
}
