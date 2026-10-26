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

export class Tunnels implements Container.Service {
  #controller: AbortController;
  #closing: Set<Promise<void>>;
  #tunnels: Map<string, Tunnels.Tunnel>;
  #logger: Logger;

  constructor(...deps: [Logger]) {
    this.#logger = deps[0].namespace("Tunnels");

    this.#controller = new AbortController();
    this.#closing = new Set();
    this.#tunnels = new Map();
  }

  ensure(id: string) {
    const existing = this.#tunnels.get(id);

    if (existing) {
      if (!existing.closed) {
        return existing;
      }

      this.#tunnels.delete(id);
      this.#trackClosing(existing.close());
    }

    if (this.#controller.signal.aborted) {
      throw this.#controller.signal.reason;
    }

    const tunnel = new Tunnels.Tunnel({ logger: this.#logger.namespace("Tunnel").binding({ id }) });

    this.#tunnels.set(id, tunnel);

    return tunnel;
  }

  get(id: string) {
    const tunnel = this.#tunnels.get(id);

    if (!tunnel) {
      return;
    }

    if (tunnel.closed) {
      this.#tunnels.delete(id);
      this.#trackClosing(tunnel.close());

      return;
    }

    return tunnel;
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
  }

  #trackClosing(promise: Promise<void>) {
    this.#closing.add(promise);

    promise.then(
      () => this.#closing.delete(promise),
      () => this.#closing.delete(promise),
    );
  }
}

export namespace Tunnels {
  type PendingStream = {
    options: Tunnel.StreamOptions;
    resolve: (stream: ClientHttp2Stream) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  };

  export class Tunnel {
    #closing?: Promise<void>;
    #controller: AbortController;
    #closeTimeoutMs: number;
    #logger: Logger;
    #sessions: Set<Tunnel.Session>;
    #queue: PendingStream[];

    constructor(options: Tunnel.Options) {
      this.#controller = new AbortController();
      this.#closeTimeoutMs = options.closeTimeoutMs ?? TUNNEL_CLOSE_TIMEOUT_MS;
      this.#logger = options.logger;
      this.#sessions = new Set();
      this.#queue = [];
    }

    get online() {
      for (const session of this.#sessions) {
        if (session.usable) {
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

      for (const session of this.#sessions) {
        connections += session.streams;
      }

      return connections;
    }

    get queue() {
      return this.#queue.length;
    }

    get closed() {
      return this.#controller.signal.aborted;
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

    close(reason?: unknown): Promise<void> {
      if (this.#closing) {
        return this.#closing;
      }

      this.#controller.abort(reason);

      const error = reason instanceof Error ? reason : new Error("Tunnel is closed");

      for (const job of this.#queue.splice(0)) {
        if (job.timer) {
          clearTimeout(job.timer);
        }

        job.reject(error);
      }

      const sessions = [...this.#sessions];

      this.#sessions.clear();

      this.#closing = (async () => {
        try {
          await Promise.all(sessions.map((session) => session.close(reason)));
        } catch {}
      })();

      return this.#closing;
    }

    #register(http2Session: ClientHttp2Session) {
      const session = new Tunnel.Session({
        logger: this.#logger,
        session: http2Session,
        closeTimeoutMs: this.#closeTimeoutMs,
        onChange: () => {
          this.#dispatch();
        },
        onClose: () => {
          this.#sessions.delete(session);
          this.#dispatch();
        },
      });

      this.#sessions.add(session);
      this.#dispatch();
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
      let selected: Tunnel.Session | undefined;
      let selectedStreams = TUNNEL_MAX_STREAMS_PER_SESSION;

      for (const session of this.#sessions) {
        if (!session.usable || session.streams >= TUNNEL_MAX_STREAMS_PER_SESSION) {
          continue;
        }

        if (session.streams < selectedStreams) {
          selected = session;
          selectedStreams = session.streams;
        }
      }

      return selected;
    }

    async #open(session: Tunnel.Session, options: Tunnel.StreamOptions) {
      return await session.request(
        {
          ":method": "CONNECT",
          ":path": options.path ?? "/",
          ":authority": options.authority,
          ":scheme": options.scheme ?? "http",
          ":protocol": options.protocol ?? "tcp",
        },
        { endStream: false, signal: this.#controller.signal },
        options.timeout,
      );
    }
  }

  export namespace Tunnel {
    export type Options = {
      logger: Logger;
      closeTimeoutMs?: number;
    };

    export type StreamOptions = {
      path?: string;
      authority: string;
      scheme?: string;
      protocol?: string;
      timeout?: number;
      priority?: number;
    };

    export class Session {
      #closeTimeoutMs: number;
      #closed: boolean;
      #closing?: Promise<void>;
      #controller: AbortController;
      #goaway: boolean;
      #logger: Logger;
      #onChange: () => void;
      #onClose: () => void;
      #request: ClientHttp2Session["request"];
      #requestFailed: boolean;
      #session: ClientHttp2Session;
      #streams: number;

      constructor(options: Session.Options) {
        this.#closeTimeoutMs = options.closeTimeoutMs ?? TUNNEL_CLOSE_TIMEOUT_MS;
        this.#closed = false;
        this.#controller = new AbortController();
        this.#goaway = false;
        this.#logger = options.logger;
        this.#onChange = options.onChange ?? (() => {});
        this.#onClose = options.onClose ?? (() => {});
        this.#request = options.session.request.bind(options.session);
        this.#requestFailed = false;
        this.#session = options.session;
        this.#streams = 0;

        this.#session.on("error", this.#handleError);
        this.#session.on("goaway", this.#handleGoaway);
        this.#session.on("close", this.#handleClose);

        this.#monitor().catch((error) => {
          if (this.#controller.signal.aborted || this.#session.closed || this.#session.destroyed) {
            return;
          }

          const reason = error instanceof Error ? error : new Error(String(error));

          this.#logger.warn("HTTP/2 session monitor failed.", { err: reason });

          if (!this.#session.destroyed) {
            this.#session.destroy(reason, constants.NGHTTP2_CANCEL);
          }
        });
      }

      get usable() {
        return !this.#requestFailed && !this.#goaway && !this.#session.closed && !this.#session.destroyed;
      }

      get streams() {
        return this.#streams;
      }

      get closed() {
        return this.#closed || this.#session.destroyed;
      }

      async request(headers: OutgoingHttpHeaders, options?: ClientSessionRequestOptions, timeout?: number) {
        if (this.#goaway) {
          throw new Error("HTTP/2 session is going away and cannot open new streams.");
        }

        let request: ClientHttp2Stream;

        try {
          request = this.#request(headers, options);
        } catch (error) {
          this.#requestFailed = true;
          this.#onChange();

          throw new Error("Failed to create HTTP/2 tunnel stream.", { cause: error });
        }

        this.#streams += 1;

        request.once("close", () => {
          this.#streams = Math.max(0, this.#streams - 1);

          if (this.#goaway && this.#streams === 0 && !this.#session.closed && !this.#session.destroyed) {
            this.#session.close();
          }

          this.#onChange();
        });

        const authority = headers[":authority"];

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

          const handleResponse = (responseHeaders: IncomingHttpHeaders & IncomingHttpStatusHeader) => {
            const status = responseHeaders[":status"];

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
                this.#logger.warn("HTTP/2 stream error.", { err: error, authority });
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

            this.#logger.warn("HTTP/2 stream error before establishment.", { err: error, authority });

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

          if (timeout !== undefined) {
            timer = setTimeout(handleTimeout, timeout);
          }
        });
      }

      async close(reason?: unknown) {
        if (this.#closing) {
          return this.#closing;
        }

        this.#controller.abort(reason);

        this.#closing = new Promise<void>((resolve) => {
          if (this.#session.destroyed) {
            return resolve();
          }

          let timer: ReturnType<typeof setTimeout> | undefined;

          const finish = () => {
            if (timer) {
              clearTimeout(timer);
            }

            this.#session.off("close", finish);
            resolve();
          };

          timer = setTimeout(() => {
            this.#logger.warn("HTTP/2 session did not close before timeout; forcing destruction.", {
              timeoutMs: this.#closeTimeoutMs,
            });

            if (!this.#session.destroyed) {
              this.#session.destroy(reason instanceof Error ? reason : new Error("Tunnel close timed out."), constants.NGHTTP2_CANCEL);
            }

            finish();
          }, this.#closeTimeoutMs);

          this.#session.once("close", finish);

          try {
            this.#session.close();
          } catch (error) {
            this.#logger.warn("Failed to gracefully close HTTP/2 session.", { err: error });

            if (!this.#session.destroyed) {
              this.#session.destroy(error instanceof Error ? error : new Error(String(error)), constants.NGHTTP2_CANCEL);
            }

            finish();
          }
        });

        return this.#closing;
      }

      #handleError = (error: Error) => {
        this.#logger.warn("HTTP/2 session error.", { err: error });
      };

      #handleGoaway = () => {
        this.#goaway = true;

        if (this.#streams === 0 && !this.#session.closed && !this.#session.destroyed) {
          this.#session.close();
        }

        this.#onChange();
      };

      #handleClose = () => {
        this.#closed = true;
        this.#controller.abort();

        this.#session.off("goaway", this.#handleGoaway);
        this.#session.off("close", this.#handleClose);

        this.#onClose();
      };

      async #monitor() {
        while (!this.#session.closed && !this.#session.destroyed && !this.#controller.signal.aborted) {
          try {
            await setTimeoutPromise(TUNNEL_PING_INTERVAL_MS, undefined, {
              ref: false,
              signal: this.#controller.signal,
            });
          } catch {
            break;
          }

          if (this.#session.closed || this.#session.destroyed || this.#controller.signal.aborted) {
            break;
          }

          await this.#ping();
        }
      }

      async #ping() {
        const signal = this.#controller.signal;

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
            this.#session.ping(TUNNEL_PING_PAYLOAD, (error) => {
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

    export namespace Session {
      export type Options = {
        logger: Logger;
        session: ClientHttp2Session;
        closeTimeoutMs?: number;
        onChange?: () => void;
        onClose?: () => void;
      };
    }
  }
}
