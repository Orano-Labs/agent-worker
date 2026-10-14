import { mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { err } from "neverthrow";

export class SocketPair {
  #server: Server;
  #socketPath: string;
  #ready: Promise<void>;

  // Pending create() waiters, keyed by their 64-bit identifier (encoded as a
  // big-endian unsigned 64-bit integer, exactly 8 bytes). Each entry carries a
  // resolve and reject so a client that fails before the server side is
  // accepted can propagate its error instead of hanging.
  #waiters: Map<bigint, SocketPair.Waiter>;

  #connections: Set<Socket>;

  constructor(options: SocketPair.Options = {}) {
    this.#socketPath = options.socketPath ?? join(tmpdir(), `socket-pair-${crypto.randomUUID()}.sock`);

    this.#server = createServer({ allowHalfOpen: true }, (socket) => {
      this.#accept(socket);

      this.#connections.add(socket);

      socket.once("close", () => {
        this.#connections.delete(socket);
      });
    });

    this.#ready = this.#listen();
    this.#waiters = new Map();
    this.#connections = new Set();
  }

  get socketPath() {
    return this.#socketPath;
  }

  ready() {
    return this.#ready;
  }

  async create() {
    await this.#ready;

    const id = this.#nextId();

    const server = new Promise<Socket>((resolve, reject) => {
      this.#waiters.set(id, { resolve, reject });
    });

    // Write the identifier first so the server can associate this connection
    // with its waiter regardless of accept ordering.
    const client = await new Promise<Socket>((resolve, reject) => {
      const client = connect({ path: this.#socketPath, allowHalfOpen: true });

      const onConnect = () => {
        cleanup();
        resolve(client);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Socket client closed before the connection was established"));
      };

      const cleanup = () => {
        client.off("connect", onConnect);
        client.off("error", onError);
        client.off("close", onClose);
      };

      client.on("connect", onConnect);
      client.on("error", onError);
      client.on("close", onClose);
    });

    const peer = await new Promise<Socket>((resolve, reject) => {
      // If the client side fails or closes before the server side has been
      // accepted, reject the pending waiter so `create()` throws instead of
      // hanging forever waiting on a peer that can never arrive.
      const onError = (error: Error) => {
        cancel(error);
        cleanup();
      };

      const onClose = () => {
        cancel(new Error("SocketPair client closed before the server side was accepted"));
        cleanup();
      };

      const cleanup = () => {
        client.off("error", onError);
        client.off("close", onClose);
      };

      const cancel = (error: Error) => {
        const waiter = this.#waiters.get(id);

        if (waiter) {
          this.#waiters.delete(id);
          waiter.reject(error);
        }
      };

      client.on("error", onError);
      client.on("close", onClose);

      client.write(this.#encodeId(id));

      server
        .then((socket) => {
          if (!client.writable || !socket.writable || !client.readable || !socket.readable) {
            if (!client.destroyed) client.destroy();
            if (!socket.destroyed) socket.destroy();

            reject(new Error("SocketPair connection is not fully open, readable, and writable on both ends"));
          }

          resolve(socket);
        })
        .catch(reject);
    });

    return { client, server: peer } satisfies SocketPair.Pair as SocketPair.Pair;
  }

  async close(timeout = 5000) {
    const force = setTimeout(() => {
      for (const socket of this.#connections) {
        if (!socket.destroyed) {
          socket.destroy();
        }
      }
    }, timeout);

    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }

        force.close();

        if (error) {
          for (const socket of this.#connections) {
            if (!socket.destroyed) {
              socket.destroy();
            }
          }
        }
      });
    });

    await rm(this.#socketPath, { force: true });
  }

  async #listen() {
    await mkdir(dirname(this.#socketPath), { recursive: true });
    // Remove a stale socket file left behind by a previous process.
    await rm(this.#socketPath, { force: true });

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
      this.#server.listen(this.#socketPath);
    });
  }

  #accept(socket: Socket) {
    // The client writes its 64-bit identifier as the first 8 bytes. We must
    // consume exactly those 8 bytes and no more before handing the socket to
    // the waiter, so the identifier never leaks into the consumer's stream.
    //
    // Use the `readable` event (paused mode) and an explicit `read(8)`: this
    // removes exactly the identifier bytes, leaving any bytes that arrived
    // after it untouched in the socket's internal read buffer. No `data`
    // listener is attached, so nothing is consumed or discarded. The socket is
    // delivered still in paused mode; the consumer's own `read`/`data`/`pipe`
    // resumes it and observes only the post-identifier payload.
    const onReadable = () => {
      // `read(8)` returns null until a full 8 bytes are buffered; it never
      // returns a partial header. Our own client always writes the complete
      // 8-byte identifier immediately upon connecting, so a `readable` event
      // that cannot yield a full header means the peer is misbehaving (a
      // foreign/stale connection). Destroy it rather than waiting indefinitely.
      const header = socket.read(SocketPair.ID_BYTES) as Buffer | null;

      if (header === null) {
        return;
      }

      cleanup();

      const id = this.#decodeId(header);
      const waiter = this.#waiters.get(id);

      if (waiter) {
        this.#waiters.delete(id);
        waiter.resolve(socket);
      } else {
        // No waiter for this identifier (already resolved, or a stale/foreign
        // connection). Drop it.
        socket.destroy();
      }
    };

    const onEnd = () => {
      cleanup(true);
    };

    const onError = () => {
      cleanup(true);
    };

    const cleanup = (destroy = false) => {
      socket.off("readable", onReadable);
      socket.off("end", onEnd);
      socket.off("error", onError);

      if (destroy) {
        socket.destroy();
      }
    };

    socket.on("readable", onReadable);
    socket.on("end", onEnd);
    socket.on("error", onError);
  }

  // Monotonic 64-bit counter for connection identifiers.
  #nextIdCounter = 0n;

  #nextId() {
    return this.#nextIdCounter++;
  }

  #encodeId(id: bigint) {
    const buffer = Buffer.allocUnsafe(SocketPair.ID_BYTES);
    buffer.writeBigUInt64BE(id);
    return buffer;
  }

  #decodeId(buffer: Buffer) {
    return buffer.readBigUInt64BE(0);
  }
}

export namespace SocketPair {
  /** Length in bytes of the 64-bit connection identifier. */
  export const ID_BYTES = 8;

  export type Options = {
    /**
     * Filesystem path of the unix socket file that realizes the pairs.
     * Defaults to a per-process path under the OS temp directory.
     */
    socketPath?: string;
  };

  export type Pair = {
    /** The dialed (client) side, returned to the caller. */
    client: Socket;
    /** The accepted (server) side, the `client`'s peer. */
    server: Socket;
  };

  export type Waiter = {
    resolve: (socket: Socket) => void;
    reject: (error: Error) => void;
  };
}
