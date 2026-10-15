import { createServer, IncomingHttpHeaders, IncomingHttpStatusHeader, ServerHttp2Stream } from "node:http2";
import { Socket } from "node:net";
import { setTimeout } from "node:timers/promises";

import { Bridge } from "@/bridge";

type ServerHttp2StreamHeaders = IncomingHttpHeaders & IncomingHttpStatusHeader;

export class TunnelGuest {
  #router: (router: Socket, headers: ServerHttp2StreamHeaders) => void;
  #concurrency: number;
  #connect: () => Socket | Promise<Socket>;
  #bridge: Bridge;

  #http2Server: ReturnType<typeof createServer>;

  #streams: Set<ServerHttp2Stream>;
  #sockets: Set<Socket>;

  #closed?: Promise<void>;

  constructor(options: TunnelGuest.Options) {
    this.#router = options.router;
    this.#concurrency = options.concurrency;
    this.#connect = options.connect;
    this.#bridge = new Bridge();
    this.#streams = new Set();
    this.#sockets = new Set();

    this.#http2Server = createServer({
      settings: {
        enableConnectProtocol: true,
      },
    });

    this.#http2Server.on("stream", (stream, headers) => {
      this.#handle(stream as ServerHttp2Stream, headers);
    });

    this.#http2Server.on("sessionError", () => {});
    this.#http2Server.on("error", () => {});

    for (let i = 0; i < this.#concurrency; i++) {
      this.#maintain();
    }
  }

  get streams() {
    return this.#streams.size;
  }

  get server() {
    return this.#http2Server;
  }

  get concurrency() {
    return this.#concurrency;
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

      for (const stream of this.#streams) {
        stream.destroy();
      }

      this.#sockets.clear();
      this.#streams.clear();

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
        socket = await this.#connect();
      } catch {
        await setTimeout(200);
        continue;
      }

      if (this.#closed || socket.destroyed) {
        return socket.destroy();
      }

      this.#sockets.add(socket);

      socket.once("close", () => {
        this.#sockets.delete(socket);
      });

      try {
        this.#http2Server.emit("connection", socket);
      } catch {
        socket.destroy();
        await setTimeout(200);
        continue;
      }

      await new Promise<void>((resolve) => {
        socket.once("close", resolve);
      });

      if (this.#closed) {
        return;
      }

      await setTimeout(200);
    }
  }

  /**
   * Bridges an extended CONNECT stream into the proxy: creates a socket pair,
   * splices the stream to one side, and feeds the other side to the HTTP/1.1
   * server as if a fresh client connection had arrived.
   */
  async #handle(stream: ServerHttp2Stream, headers: ServerHttp2StreamHeaders) {
    if (this.#closed) {
      stream.respond({ ":status": 500 });
      stream.end();
      return;
    }

    const method = headers[":method"];
    const protocol = headers[":protocol"];

    if (Array.isArray(method) || method?.toUpperCase() !== "CONNECT") {
      stream.respond({ ":status": 405 });
      stream.end();
      return;
    }

    if (Array.isArray(protocol) || protocol?.toUpperCase() !== "TCP") {
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

    const socket = await this.#bridge.pipe(stream).catch(() => null);

    if (!socket) {
      stream.respond({ ":status": 500 });
      stream.end();

      return;
    }

    stream.respond({ ":status": 200 });

    this.#streams.add(stream);

    stream.once("close", () => {
      this.#streams.delete(stream);
    });

    try {
      this.#router(socket, headers);
    } catch (error) {
      dispose(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export namespace TunnelGuest {
  export type Headers = ServerHttp2StreamHeaders;

  export type Options = {
    router: (socket: Socket, headers: Headers) => void;
    concurrency: number;
    connect: () => Socket | Promise<Socket>;
  };
}
