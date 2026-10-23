import { EventEmitter } from "node:events";
import {
  ClientHttp2Session,
  ClientHttp2Stream,
  ClientSessionRequestOptions,
  connect,
  constants,
  IncomingHttpHeaders,
  IncomingHttpStatusHeader,
  OutgoingHttpHeaders,
} from "node:http2";
import { Duplex } from "node:stream";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { Container } from "@aw/container";
import { Logger } from "@aw/logging";

const TUNNEL_PING_INTERVAL_MS = 30_000;
const TUNNEL_PING_TIMEOUT_MS = 5_000;
const TUNNEL_CLOSE_TIMEOUT_MS = 5_000;
const TUNNEL_PING_PAYLOAD = Buffer.alloc(8);
const TUNNEL_MAX_STREAMS_PER_SESSION = 128;

export class Tunnels extends EventEmitter<Tunnels.Events> implements Container.Service {
  #controller: AbortController;
  #closing: Set<Promise<void>>;
  #tunnels: Map<string, Tunnels.Tunnel>;
  #logger: Logger;

  constructor(...deps: [Logger]) {
    super();

    this.#logger = deps[0].namespace("Tunnels");

    this.#controller = new AbortController();
    this.#closing = new Set();
    this.#tunnels = new Map();
  }

  ensure(id: string) {
    const existing = this.#tunnels.get(id);

    if (existing) {
      return existing;
    }

    if (this.#controller.signal.aborted) {
      throw this.#controller.signal.reason;
    }

    const tunnel = new Tunnels.Tunnel({ logger: this.#logger.namespace("Tunnel").binding({ id }) });

    tunnel.on("close", (promise) => {
      this.#tunnels.delete(id);
      this.#closing.add(promise);

      promise.then(
        () => this.#closing.delete(promise),
        () => this.#closing.delete(promise),
      );

      this.emit("close", id, tunnel, promise);
    });

    this.#tunnels.set(id, tunnel);

    this.emit("create", id, tunnel);

    return tunnel;
  }

  get(id: string) {
    return this.#tunnels.get(id);
  }

  *iterator() {
    for (const entry of this.#tunnels) {
      if (entry[1].online) {
        yield entry;
      }
    }
  }

  get [Container.SymbolDispose]() {
    return this.dispose.bind(this);
  }

  protected async dispose(reason?: unknown) {
    this.#controller.abort(reason);

    const closing = [...this.#closing.values()];
    const active = [...this.#tunnels.values()].map((tunnel) => tunnel.close(reason));

    await Promise.all([...closing, ...active]);

    this.#tunnels.clear();
    this.#closing.clear();

    this.removeAllListeners();
  }
}

export namespace Tunnels {
  export type Events = {
    create: [id: string, tunnel: Tunnel];
    close: [id: string, tunnel: Tunnel, promise: Promise<void>];
  };

  type PendingStream = {
    options: Tunnel.StreamOptions;
    resolve: (stream: ClientHttp2Stream) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  };

  export class Tunnel extends EventEmitter<Tunnel.Events> {
    #controller: AbortController;
    #closeTimeoutMs: number;
    // Last emitted value, used only to suppress duplicate online events.
    #lastOnline: boolean;
    #logger: Logger;
    #sessions: Map<ClientHttp2Session, Tunnel.SessionState>;
    #queue: PendingStream[];

    constructor(options: Tunnel.Options) {
      super();

      this.#controller = new AbortController();
      this.#closeTimeoutMs = options.closeTimeoutMs ?? TUNNEL_CLOSE_TIMEOUT_MS;
      this.#lastOnline = false;
      this.#logger = options.logger;
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

    get closed() {
      return this.#controller.signal.aborted;
    }

    request(headers: OutgoingHttpHeaders, options: ClientSessionRequestOptions = {}) {
      if (this.closed) {
        throw new Error("Tunnel is closed");
      }

      const session = this.#pick();

      if (!session) {
        throw new Error("No available tunnel session");
      }

      return session.request(headers, options);
    }

    async upgrade(socket: Duplex) {
      if (this.closed) {
        throw new Error("Tunnel is closed");
      }

      const session = await new Promise<ClientHttp2Session>((resolve, reject) => {
        const session = connect("http://localhost:2000", {
          createConnection: () => socket,
        });

        const cleanup = () => {
          session.off("error", handleError);
          session.off("connect", handleConnect);
          session.off("close", handleClose);

          this.#controller.signal.removeEventListener("abort", handleAborted);
        };

        const settle = (callback: () => void) => {
          cleanup();
          callback();
        };

        const handleError = (error: Error) => {
          settle(() => {
            if (!session.destroyed) {
              session.destroy();
            }

            reject(error);
          });
        };

        const handleConnect = () => {
          settle(() => {
            resolve(session);
          });
        };

        const handleClose = () => {
          settle(() => {
            if (!session.destroyed) {
              session.destroy();
            }

            reject(new Error("HTTP/2 session closed before it was established"));
          });
        };

        const handleAborted = () => {
          settle(() => {
            if (!session.destroyed) {
              session.destroy();
            }

            reject(this.#controller.signal.reason ?? new Error("Tunnel was closed"));
          });
        };

        session.on("error", handleError);
        session.on("connect", handleConnect);
        session.on("close", handleClose);

        this.#controller.signal.addEventListener("abort", handleAborted, { once: true });
      });

      session.on("error", (error) => {
        this.#logger.warn("HTTP/2 session error.", { err: error });
      });

      if (this.closed) {
        if (!session.destroyed) {
          session.destroy();
        }

        throw new Error("Tunnel is closed");
      }

      this.#register(session);
    }

    async stream(options: Tunnel.StreamOptions) {
      if (this.closed) {
        throw new Error("Tunnel is closed");
      }

      return await new Promise<ClientHttp2Stream>((resolve, reject) => {
        const job: PendingStream = {
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
      if (this.closed) {
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

      const promise = (async () => {
        try {
          await Promise.all(sessions.map((session) => this.#closeSession(session, reason, this.#closeTimeoutMs)));
        } catch {}

        this.removeAllListeners();
      })();

      this.emit("close", promise);

      await promise;
    }

    async #closeSession(session: ClientHttp2Session, reason: unknown, timeout: number) {
      return new Promise<void>((resolve) => {
        if (session.destroyed) {
          return resolve();
        }

        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = () => {
          if (timer) {
            clearTimeout(timer);
          }

          session.off("close", finish);
          resolve();
        };

        timer = setTimeout(() => {
          this.#logger.warn("HTTP/2 session did not close before timeout; forcing destruction.", {
            timeoutMs: timeout,
          });

          if (!session.destroyed) {
            session.destroy(reason instanceof Error ? reason : new Error("Tunnel close timed out."), constants.NGHTTP2_CANCEL);
          }

          finish();
        }, timeout);

        session.once("close", finish);

        try {
          session.close();
        } catch (error) {
          this.#logger.warn("Failed to gracefully close HTTP/2 session.", { err: error });

          if (!session.destroyed) {
            session.destroy(error instanceof Error ? error : new Error(String(error)), constants.NGHTTP2_CANCEL);
          }

          finish();
        }
      });
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
        if (goaway) {
          throw new Error("HTTP/2 session is going away and cannot open new streams.");
        }

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

      const handleGoaway = () => {
        goaway = true;
        this.#updateOnline();

        if (streams === 0 && !session.closed && !session.destroyed) {
          session.close();
        }
      };

      const handleClose = () => {
        controller.abort();

        this.#sessions.delete(session);

        this.#updateOnline();
        this.#dispatch();

        session.off("goaway", handleGoaway);
        session.off("close", handleClose);
      };

      session.on("goaway", handleGoaway);
      session.on("close", handleClose);

      this.#updateOnline();
      this.#dispatch();

      this.#monitor(session, controller.signal).catch((error) => {
        if (controller.signal.aborted || session.closed || session.destroyed) {
          return;
        }

        const reason = error instanceof Error ? error : new Error(String(error));

        this.#logger.warn("HTTP/2 session monitor failed.", { err: reason });

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
      if (this.closed) {
        return;
      }

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
      const requestOptions: ClientSessionRequestOptions = { endStream: false, signal: this.#controller.signal };
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

            if (error) {
              this.#logger.warn("HTTP/2 stream error.", { err: error, authority: options.authority });
            }

            if (!request.destroyed) {
              request.destroy();
            }
          };

          request.once("error", dispose);
          request.once("close", dispose);

          resolve(request);
        };

        const handleError = (error: Error) => {
          cleanup();

          this.#logger.warn("HTTP/2 stream error before establishment.", { err: error, authority: options.authority });

          if (!request.destroyed) {
            request.destroy();
          }

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
      closeTimeoutMs?: number;
    };

    export type Events = {
      online: [online: boolean];
      close: [promise: Promise<void>];
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

    export class Session {}
  }
}
