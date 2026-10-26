import { mkdir, rm } from "node:fs/promises";
import { Agent, ClientRequestArgs, RequestOptions, request } from "node:http";
import { connect, createServer, Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Duplex } from "node:stream";
import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { Tunnels } from "@/internal/tunnels";

export class TunnelsAgent extends Container.ServiceConstructable {
  #agent: TunnelsAgent.HttpAgent;

  constructor(...deps: [Environment, Logger, Tunnels]) {
    super();

    this.#agent = new TunnelsAgent.HttpAgent({ tunnels: deps[2] });
  }

  createSocketConnection() {
    request({
      createConnection: () => {},
    });
  }
}

export namespace TunnelsAgent {
  export type SocketConnectionOptions = {
    target: string;
  };

  export class HttpAgent {
    #server: Server;
    #ready: Promise<void>;
    #waiters: Map<bigint, PromiseWithResolvers<Socket>>;
    #path: string;

    // Monotonic 64-bit counter for connection identifiers.
    #counter: bigint;
    #connections: Map<Socket, Socket | null>;

    #closed?: Promise<void>;

    #tunnels: Tunnels;

    constructor(options: HttpAgent.Options) {
      this.#path = join(tmpdir(), `http-agent-socket-pair-${crypto.randomUUID()}.sock`);

      this.#ready = this.#listen();
      this.#waiters = new Map();
      this.#connections = new Map();
      this.#counter = 0n;

      this.#server = createServer({ allowHalfOpen: true }, (socket) => {
        const onReadable = () => {
          const header = socket.read(8) as Buffer | null;

          if (header === null) {
            return;
          }

          socket.off("readable", onReadable);
          socket.off("end", onEnd);
          socket.off("error", onError);

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
          socket.off("readable", onReadable);
          socket.off("end", onEnd);
          socket.off("error", onError);
          socket.destroy();
        };

        const onError = () => {
          socket.off("readable", onReadable);
          socket.off("end", onEnd);
          socket.off("error", onError);
          socket.destroy();
        };

        socket.on("readable", onReadable);
        socket.on("end", onEnd);
        socket.on("error", onError);

        this.#connections.set(socket, null);

        socket.once("close", () => {
          this.#connections.delete(socket);
        });
      });

      this.#tunnels = options.tunnels;
    }

    get connections() {
      return this.#connections.size;
    }

    async ready() {
      if (this.#closed) {
        throw new Error("SocketPair is closing or closed");
      }

      return this.#ready;
    }

    async close(timeout = 5000) {
      if (this.#closed) {
        return this.#closed;
      }

      this.#closed = (async () => {
        const forceCloseTimer = setTimeout(() => {
          const reason = new Error(
            `SocketPair.close() timed out after ${timeout}ms; forcibly destroying ${this.#connections.size} connection(s).`,
          );

          for (const [server, client] of this.#connections) {
            if (!server.destroyed) {
              server.destroy(reason);
            }

            if (client && !client.destroyed) {
              client.destroy(reason);
            }
          }

          this.#connections.clear();
        }, timeout);

        for (const waiter of this.#waiters.values()) {
          waiter.reject(new Error("SocketPair is closed."));
        }

        await new Promise<void>((resolve, reject) => {
          this.#server.close((error) => {
            if (error) {
              const reason = new Error(`SocketPair.close() failed while closing the server: ${error.message}`, { cause: error });

              for (const [server, client] of this.#connections) {
                if (!server.destroyed) {
                  server.destroy(reason);
                }

                if (client && !client.destroyed) {
                  client.destroy(reason);
                }

                this.#connections.clear();
              }

              reject(error);
            } else {
              resolve();
            }

            clearTimeout(forceCloseTimer);
          });
        });

        await rm(this.#path, { force: true });
      })();
    }

    async #listen() {
      await mkdir(dirname(this.#path), { recursive: true });
      // Remove a stale socket file left behind by a previous process.
      await rm(this.#path, { force: true });

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
        this.#server.listen(this.#path);
      });
    }

    async #createSocketPier() {
      await this.#ready;

      const id = this.#generateId();
      const waiter = Promise.withResolvers<Socket>();

      this.#waiters.set(id, waiter);

      // Write the identifier first so the server can associate this connection
      // with its waiter regardless of accept ordering.
      const client = await new Promise<Socket>((resolve, reject) => {
        const client = connect({ path: this.#path, allowHalfOpen: true });

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
          this.#waiters.get(id)?.reject(error);
          this.#waiters.delete(id);

          client.off("error", onError);
          client.off("close", onClose);
        };

        const onClose = () => {
          this.#waiters.get(id)?.reject(new Error("SocketPair client closed before the server side was accepted"));
          this.#waiters.delete(id);

          client.off("error", onError);
          client.off("close", onClose);
        };

        client.on("error", onError);
        client.on("close", onClose);

        client.write(this.#encodeId(id));

        waiter.promise
          .then((socket) => {
            if (this.#connections.get(socket) !== null) {
              if (!client.destroyed) client.destroy();
              if (!socket.destroyed) socket.destroy();

              return reject(new Error("SocketPair.create() received a server socket that is already paired with another client"));
            }

            this.#connections.set(socket, client);

            if (!client.writable || !socket.writable || !client.readable || !socket.readable) {
              if (!client.destroyed) client.destroy();
              if (!socket.destroyed) socket.destroy();

              return reject(new Error("SocketPair connection is not fully open, readable, and writable on both ends"));
            }

            resolve(socket);
          })
          .catch(reject);
      });

      return { client, server: peer };
    }

    #generateId() {
      return this.#counter++;
    }

    #encodeId(id: bigint) {
      const buffer = Buffer.allocUnsafe(8);
      buffer.writeBigUInt64BE(id);
      return buffer;
    }

    #decodeId(buffer: Buffer) {
      return buffer.readBigUInt64BE(0);
    }
  }

  export namespace HttpAgent {
    export type Options = {
      tunnels: Tunnels;
    };
  }
}
