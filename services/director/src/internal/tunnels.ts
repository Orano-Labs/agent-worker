import { EventEmitter } from "node:events";
import {
  ClientHttp2Session,
  ClientHttp2Stream,
  ClientSessionRequestOptions,
  connect,
  constants,
  IncomingHttpHeaders,
  IncomingHttpStatusHeader,
} from "node:http2";
import { Duplex } from "node:stream";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { Container } from "@aw/container";
import { Logger } from "@aw/logging";

const TUNNEL_PING_INTERVAL_MS = 30_000;
const TUNNEL_PING_TIMEOUT_MS = 5_000;
const TUNNEL_PING_PAYLOAD = Buffer.alloc(8);
const TUNNEL_MAX_STREAMS_PER_SESSION = 128;

export class Tunnels extends Container.ServiceConstructable {
  #controller: AbortController;
  #tunnels: Map<string, Tunnels.Tunnel>;
  #logger: Logger;

  constructor(...deps: [Logger]) {
    super();

    this.#logger = deps[0].namespace("Tunnels");

    this.#controller = new AbortController();
    this.#tunnels = new Map();
  }

  ensure(id: string) {
    let tunnel = this.#tunnels.get(id);

    if (!tunnel) {
      if (this.#controller.signal.aborted) {
        throw this.#controller.signal.reason;
      }

      tunnel = new Tunnels.Tunnel({ logger: this.#logger.namespace("Tunnel").binding({ id }) });
    }

    this.#tunnels.set(id, tunnel);

    return tunnel;
  }

  protected override async dispose(reason?: unknown) {
    this.#controller.abort(reason);

    await Promise.all(
      [...this.#tunnels.values()].map((tunnel) => {
        return tunnel.close(reason);
      }),
    );

    this.#tunnels.clear();
  }
}

export namespace Tunnels {
  type PendingStream = {
    options: Tunnel.StreamOptions;
    resolve: (stream: ClientHttp2Stream) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  };

  export class Tunnel extends EventEmitter<Tunnel.Events> {
    #controller: AbortController;
    // Last emitted value, used only to suppress duplicate online events.
    #lastOnline: boolean;
    #sessions: Map<ClientHttp2Session, Tunnel.SessionState>;
    #queue: PendingStream[];

    constructor(_options: Tunnel.Options) {
      super();

      this.#controller = new AbortController();
      this.#lastOnline = false;
      this.#sessions = new Map();
      this.#queue = [];
    }

    get online() {
      for (const state of this.#sessions.values()) {
        if (state.usable) {
          return true;
        }
      }

      return false;
    }

    get sessions() {
      return this.#sessions.size;
    }

    get connections() {
      let connections = 0;

      for (const state of this.#sessions.values()) {
        connections += state.streams;
      }

      return connections;
    }

    get queue() {
      return this.#queue.length;
    }

    async upgrade(socket: Duplex) {
      if (this.#controller.signal.aborted) {
        throw this.#controller.signal.reason;
      }

      const session = await new Promise<ClientHttp2Session>((resolve, reject) => {
        const session = connect("http://localhost:2000", {
          createConnection: () => socket,
        });

        let settled = false;

        const cleanup = () => {
          session.off("error", handleError);
          session.off("connect", handleConnect);
          session.off("close", handleClose);

          this.#controller.signal.removeEventListener("abort", handleAborted);
        };

        const settle = (callback: () => void) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          callback();
        };

        const handleError = (error: Error) => {
          settle(() => {
            session.destroy();
            reject(error);
          });
        };

        const handleConnect = () => {
          settle(() => resolve(session));
        };

        const handleClose = () => {
          settle(() => reject(new Error("HTTP/2 session closed before it was established")));
        };

        const handleAborted = () => {
          settle(() => {
            session.destroy();
            reject(this.#controller.signal.reason ?? new Error("Tunnel was closed"));
          });
        };

        session.on("error", handleError);
        session.on("connect", handleConnect);
        session.on("close", handleClose);

        this.#controller.signal.addEventListener("abort", handleAborted, { once: true });
      });

      if (this.#controller.signal.aborted) {
        if (!session.destroyed) {
          session.destroy();
        }

        throw this.#controller.signal.reason;
      }

      this.#register(session);
    }

    async stream(options: Tunnel.StreamOptions) {
      if (this.#controller.signal.aborted) {
        throw this.#controller.signal.reason;
      }

      return await new Promise<ClientHttp2Stream>((resolve, reject) => {
        const job: {
          options: Tunnel.StreamOptions;
          resolve: (stream: ClientHttp2Stream) => void;
          reject: (error: Error) => void;
          timer?: ReturnType<typeof setTimeout>;
        } = {
          options,
          resolve,
          reject,
        };

        const handleTimeout = () => {
          const index = this.#queue.indexOf(job);

          if (index !== -1) {
            this.#queue.splice(index, 1);
          }

          reject(new Error("Timed out waiting for an available tunnel stream slot."));
        };

        if (options.timeout !== undefined) {
          job.timer = setTimeout(handleTimeout, options.timeout);
        }

        this.#enqueue(job);
        this.#dispatch();
      });
    }

    async close(reason?: unknown) {
      if (this.#controller.signal.aborted) {
        return;
      }

      this.#controller.abort(reason);

      const error = reason instanceof Error ? reason : new Error("Tunnel is closed");

      for (const job of this.#queue.splice(0)) {
        if (job.timer) {
          clearTimeout(job.timer);
        }

        job.reject(error);
      }

      const sessions = [...this.#sessions.keys()];

      this.#sessions.clear();
      this.#updateOnline();
      this.removeAllListeners();

      await Promise.all(
        sessions.map((session) => {
          return new Promise<void>((resolve) => {
            if (session.closed || session.destroyed) {
              return resolve();
            }

            session.once("close", () => resolve());
            session.destroy(undefined, constants.NGHTTP2_CANCEL);
          });
        }),
      );
    }

    #register(session: ClientHttp2Session) {
      let streams = 0;
      let goaway = false;
      let requestFailed = false;

      const controller = new AbortController();

      const state: Tunnel.SessionState = {
        get usable() {
          return !requestFailed && !goaway && !session.closed && !session.destroyed;
        },
        get streams() {
          return streams;
        },
      };

      const request = session.request.bind(session);

      session.request = (headers, options) => {
        let stream: ClientHttp2Stream;

        try {
          stream = request(headers, options);
        } catch (error) {
          requestFailed = true;
          this.#updateOnline();

          throw new Error("Failed to create HTTP/2 tunnel stream.", { cause: error });
        }

        streams += 1;

        stream.once("close", () => {
          streams = Math.max(0, streams - 1);

          if (goaway && streams === 0 && !session.closed && !session.destroyed) {
            session.close();
          }

          this.#dispatch();
        });

        return stream;
      };

      this.#sessions.set(session, state);
      this.#updateOnline();

      session.on("error", () => {});

      session.on("goaway", () => {
        goaway = true;
        this.#updateOnline();

        if (streams === 0 && !session.closed && !session.destroyed) {
          session.close();
        }
      });

      session.on("close", () => {
        controller.abort();
        this.#sessions.delete(session);
        this.#updateOnline();
        this.#dispatch();
      });

      this.#dispatch();

      this.#monitor(session, controller.signal).catch((error) => {
        if (controller.signal.aborted || session.closed || session.destroyed) {
          return;
        }

        const reason = error instanceof Error ? error : new Error(String(error));

        if (!session.destroyed) {
          session.destroy(reason, constants.NGHTTP2_CANCEL);
        }
      });
    }

    #enqueue(job: PendingStream) {
      const priority = job.options.priority;

      if (priority === undefined) {
        this.#queue.push(job);

        return;
      }

      const index = this.#queue.findIndex((queued) => {
        const queuedPriority = queued.options.priority;

        return queuedPriority === undefined || queuedPriority < priority;
      });

      if (index === -1) {
        this.#queue.push(job);
      } else {
        this.#queue.splice(index, 0, job);
      }
    }

    #updateOnline() {
      const online = this.online;

      if (online === this.#lastOnline) {
        return;
      }

      this.#lastOnline = online;
      this.emit("online", online);
    }

    #dispatch() {
      while (this.#queue.length > 0) {
        const session = this.#pick();

        if (!session) {
          return;
        }

        const job = this.#queue.shift();

        if (!job) {
          return;
        }

        if (job.timer) {
          clearTimeout(job.timer);
        }

        this.#open(session, job.options).then(job.resolve, job.reject);
      }
    }

    #pick() {
      let selected: ClientHttp2Session | undefined;
      let selectedStreams = TUNNEL_MAX_STREAMS_PER_SESSION;

      for (const [session, state] of this.#sessions) {
        if (!state.usable || state.streams >= TUNNEL_MAX_STREAMS_PER_SESSION) {
          continue;
        }

        if (state.streams < selectedStreams) {
          selected = session;
          selectedStreams = state.streams;
        }
      }

      return selected;
    }

    async #open(session: ClientHttp2Session, options: Tunnel.StreamOptions) {
      const requestOptions: ClientSessionRequestOptions = { endStream: false };
      const request = session.request(
        {
          ":method": "CONNECT",
          ":path": options.path ?? "/",
          ":authority": options.authority,
          ":scheme": options.scheme ?? "http",
          ":protocol": options.protocol ?? "tcp",
        },
        requestOptions,
      );

      return await new Promise<ClientHttp2Stream>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          request.off("response", handleResponse);
          request.off("error", handleError);
          request.off("close", handleClose);
          request.off("aborted", handleAborted);

          if (timer) {
            clearTimeout(timer);
          }
        };

        const handleResponse = (headers: IncomingHttpHeaders & IncomingHttpStatusHeader) => {
          const status = headers[":status"];

          if (status !== 200) {
            cleanup();
            request.destroy();
            reject(new Error(`HTTP/2 CONNECT failed with status ${status ?? "unknown"}`));

            return;
          }

          cleanup();

          const dispose = (error?: Error) => {
            request.off("error", dispose);
            request.off("close", dispose);

            if (!request.destroyed) {
              request.destroy(error);
            }
          };

          request.once("error", dispose);
          request.once("close", dispose);

          resolve(request);
        };

        const handleError = (error: Error) => {
          cleanup();
          reject(error);
        };

        const handleClose = () => {
          cleanup();
          reject(new Error("HTTP/2 stream closed before the tunnel was established"));
        };

        const handleAborted = () => {
          cleanup();
          reject(new Error("HTTP/2 stream aborted before the tunnel was established"));
        };

        const handleTimeout = () => {
          cleanup();
          request.destroy();
          reject(new Error("HTTP/2 stream timed out before the tunnel was established"));
        };

        request.once("response", handleResponse);
        request.once("error", handleError);
        request.once("close", handleClose);
        request.once("aborted", handleAborted);

        if (options.timeout !== undefined) {
          timer = setTimeout(handleTimeout, options.timeout);
        }
      });
    }

    async #monitor(session: ClientHttp2Session, signal: AbortSignal) {
      while (!session.closed && !session.destroyed && !signal.aborted) {
        try {
          await setTimeoutPromise(TUNNEL_PING_INTERVAL_MS, undefined, {
            ref: false,
            signal,
          });
        } catch {
          break;
        }

        if (session.closed || session.destroyed || signal.aborted) {
          break;
        }

        await this.#ping(session, signal);
      }
    }

    async #ping(session: ClientHttp2Session, signal: AbortSignal) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          return reject(signal.reason);
        }

        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("HTTP/2 PING timeout"));
        }, TUNNEL_PING_TIMEOUT_MS);

        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", handleAborted);
        };

        const handleAborted = () => {
          cleanup();
          reject(signal.reason);
        };

        timer.unref();
        signal.addEventListener("abort", handleAborted, { once: true });

        try {
          session.ping(TUNNEL_PING_PAYLOAD, (error) => {
            cleanup();

            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
    }
  }

  export namespace Tunnel {
    export type Options = {
      logger: Logger;
    };

    export type Events = {
      online: [online: boolean];
    };

    export type StreamOptions = {
      path?: string;
      authority: string;
      scheme?: string;
      protocol?: string;
      timeout?: number;
      priority?: number;
    };

    export type SessionState = {
      readonly usable: boolean;
      readonly streams: number;
    };
  }
}
