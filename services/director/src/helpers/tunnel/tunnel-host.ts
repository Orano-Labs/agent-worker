import {
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type ClientSessionRequestOptions,
  connect,
  constants,
  type IncomingHttpHeaders,
  type IncomingHttpStatusHeader,
  type OutgoingHttpHeaders,
} from "node:http2";
import type { Socket } from "node:net";
import { SocketPair } from "./socket-pair";

export class TunnelHost {
  #sessions: Set<TunnelHost.Session>;
  #pairs: SocketPair;
  #closed?: Promise<void>;
  #queue: Array<TunnelHost.ConnectQueueJob>;

  #sessionOptions?: TunnelHost.Session.Options;

  constructor(options: TunnelHost.Options = {}) {
    this.#sessions = new Set();
    this.#pairs = new SocketPair({
      socketPath: options.socketPath,
    });
    this.#queue = [];
    this.#sessionOptions = options.session;
  }

  async upgrade(socket: Socket) {
    if (this.#closed) {
      throw new Error("TunnelHost is closed; cannot upgrade a new session");
    }

    const raw = await new Promise<ClientHttp2Session>((resolve, reject) => {
      const session = connect("http://localhost:2000", {
        createConnection: () => socket,
      });

      const handleError = (error: Error) => {
        reject(error);
        cleanup();
      };

      const handleConnect = () => {
        resolve(session);
        cleanup();
      };

      const cleanup = () => {
        session.off("error", handleError);
        session.off("connect", handleConnect);
      };

      session.on("error", handleError);
      session.on("connect", handleConnect);
    });

    if (this.#closed) {
      return raw.destroy();
    }

    const session = new TunnelHost.Session(raw, this.#sessionOptions);

    raw.once("close", () => {
      this.#sessions.delete(session);
    });

    this.#sessions.add(session);
    this.#dispatch();
  }

  async connect(options: TunnelHost.ConnectOptions = {}) {
    if (this.#closed) {
      throw new Error("TunnelHost is closed; cannot open a new connection");
    }

    await this.#pairs.ready();

    const timeoutMs = options.timeoutMs ?? 30_000;

    return new Promise<Socket>((resolve, reject) => {
      const job: TunnelHost.ConnectQueueJob = {
        authority: options.authority ?? "",
        protocol: options.protocol ?? "tcp",
        timer: setTimeout(() => {
          const index = this.#queue.indexOf(job);

          if (index >= 0) {
            this.#queue.splice(index, 1);
          }

          reject(new Error("No HTTP/2 session stream slot became available before timeout"));
        }, timeoutMs),

        resolve: (result) => {
          if (result instanceof Error) {
            return reject(result);
          }

          this.#prepareStream(result).then(resolve, reject);
        },
      };

      this.#queue.push(job);
      this.#dispatch();
    });
  }

  async close() {
    if (this.#closed) {
      return this.#closed;
    }

    this.#closed = this.#drain();

    return this.#closed;
  }

  async #drain() {
    // Reject any queued `connect()` requests that never got a chance to run.
    for (const job of this.#queue.splice(0)) {
      job.timer.close();
      job.resolve(new Error("TunnelHost is closed"));
    }

    // First close every session gracefully, so active `:connect` streams have
    // a chance to finish before their transport is torn down. Each session
    // closes independently; wait for all of them concurrently.
    await Promise.all([...this.#sessions].map((session) => session.close()));

    this.#sessions.clear();

    // Finally stop accepting new socket-pair connections and remove the file.
    await this.#pairs.close();
  }

  /**
   * Prepares a freshly issued `:connect` stream for use: waits until the peer
   * accepts it (the `response` event), then creates a bridge socket pair and
   * splices the stream to its server side. Resolves with the client-side
   * `net.Socket` that the caller may use as if it were the tunnel itself.
   */
  async #prepareStream(stream: ClientHttp2Stream) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        stream.off("response", onResponse);
        stream.off("error", onError);
        stream.off("close", onClose);
      };

      const onResponse = (headers: IncomingHttpHeaders & IncomingHttpStatusHeader) => {
        cleanup();

        if (headers[":status"] !== 200) {
          reject(new Error(`HTTP/2 CONNECT failed: status ${headers[":status"]}`));
        } else {
          resolve();
        }
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Stream closed before the tunnel was established"));
      };

      stream.once("response", onResponse);
      stream.once("error", onError);
      stream.once("close", onClose);
    });

    const pair = await this.#pairs.create();

    if (stream.destroyed || stream.closed) {
      pair.client.destroy();
      pair.server.destroy();

      throw new Error("HTTP/2 stream closed before bridge setup");
    }

    const { client, server } = pair;

    let disposed = false;

    const dispose = (error?: Error) => {
      if (disposed) {
        return;
      }

      disposed = true;

      stream.off("error", onStreamError);
      stream.off("close", onStreamClose);
      client.off("error", onPairError);
      client.off("close", onClientClose);
      server.off("error", onPairError);
      server.off("close", onServerClose);

      if (!client.destroyed) client.destroy(error);
      if (!server.destroyed) server.destroy(error);
    };

    const onStreamError = (err: Error) => dispose(err);
    const onStreamClose = () => dispose();
    const onPairError = (err: Error) => dispose(err);
    const onClientClose = () => dispose();
    const onServerClose = () => dispose();

    stream.on("error", onStreamError);
    stream.once("close", onStreamClose);
    client.on("error", onPairError);
    client.once("close", onClientClose);
    server.on("error", onPairError);
    server.once("close", onServerClose);

    if (stream.destroyed || stream.closed || client.destroyed || server.destroyed) {
      dispose();
      throw new Error("Stream closed during bridge setup");
    }

    stream.pipe(server);
    server.pipe(stream);

    return client;
  }

  #dispatch() {
    while (true) {
      const session = this.#pickAvailableSession();

      if (!session) {
        return;
      }

      const job = this.#queue.shift();

      if (!job) {
        return;
      }

      job.timer.close();

      try {
        const stream = session.request(
          {
            ":method": "CONNECT",
            ":path": "/",
            ":authority": job.authority,
            ":scheme": "http",
            ":protocol": job.protocol,
          },
          {
            endStream: false,
          },
        );

        stream.once("close", () => {
          this.#dispatch();
        });

        job.resolve(stream);
      } catch (error) {
        job.resolve(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #pickAvailableSession() {
    let selected: TunnelHost.Session | undefined;

    for (const session of this.#sessions) {
      if (!session.available) {
        continue;
      }

      if (!selected) {
        selected = session;
      } else if (session.activeStreamCount < selected.activeStreamCount) {
        selected = session;
      }
    }

    return selected;
  }
}

export namespace TunnelHost {
  export type Options = {
    /**
     * Filesystem path of the unix socket file that acts as the `net.Socket`
     * pair generator. Defaults to a per-process path under the OS temp
     * directory.
     */
    socketPath?: string;
    session?: Session.Options;
  };

  export type ConnectOptions = {
    /**
     * `:authority` pseudo-header value, i.e. the host/port the guest should
     * dial. Required for extended CONNECT (RFC 8441).
     */
    authority?: string;
    /**
     * `:protocol` pseudo-header value describing the protocol the guest should
     * speak once the stream is established. Defaults to "tcp".
     */
    protocol?: string;
    /**
     * Maximum time to wait for an available session before failing.
     * Defaults to 30s.
     */
    timeoutMs?: number;
  };

  export type ConnectQueueJob = {
    authority: string;
    protocol: string;
    resolve: (result: ClientHttp2Stream | Error) => void;
    timer: NodeJS.Timeout;
  };

  export class Session {
    #raw: ClientHttp2Session;
    #streams: Set<ClientHttp2Stream>;

    #receivedGoAway?: { errorCode: number; lastStreamID: number; opaqueData?: Buffer };
    #receivedError?: Error;

    #idleTimeoutMs: number;
    #probeTimeoutMs: number;
    #probeFailureThreshold: number;
    #maxConcurrentStreams: number;

    #handleError = (error: Error) => {
      this.#receivedError = error;
    };

    #handleClose = () => {
      this.#raw.off("error", this.#handleError);
      this.#raw.off("close", this.#handleClose);
      this.#raw.off("goaway", this.#handleGoAway);
      this.#raw.off("timeout", this.#handleTimeout);

      this.#streams.clear();
    };

    #handleGoAway = (errorCode: number, lastStreamID: number, opaqueData?: Buffer) => {
      this.#receivedGoAway = {
        errorCode,
        lastStreamID,
        opaqueData,
      };

      if (this.#streams.size === 0) {
        this.#raw.close();
      }
    };

    #handleTimeout = () => {
      if (this.closed || this.destroyed) {
        return;
      }

      this.#probe();
    };

    constructor(raw: ClientHttp2Session, options: Session.Options = {}) {
      this.#raw = raw;

      this.#streams = new Set();

      this.#idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
      this.#probeTimeoutMs = options.probeTimeoutMs ?? 3_000;
      this.#probeFailureThreshold = options.probeFailureThreshold ?? 3;
      this.#maxConcurrentStreams = options.maxConcurrentStreams ?? 100;

      this.#raw.on("error", this.#handleError);
      this.#raw.on("close", this.#handleClose);
      this.#raw.on("goaway", this.#handleGoAway);
      this.#raw.on("timeout", this.#handleTimeout);

      // The session-level timeout fires after the given duration of inactivity
      // (no active streams). It fires only once, so `#handleTimeout` is
      // responsible for re-arming it via `setTimeout` after each probe.
      this.#raw.setTimeout(this.#idleTimeoutMs);
    }

    get activeStreamCount() {
      return this.#streams.size;
    }

    get available() {
      return this.state === "open" && this.#streams.size < this.#maxConcurrentStreams;
    }

    get maxConcurrentStreams() {
      return this.#maxConcurrentStreams;
    }

    get closed() {
      return this.#raw.closed;
    }

    get destroyed() {
      return this.#raw.destroyed;
    }

    get state(): Session.State {
      if (this.#receivedError) {
        return "error";
      }

      if (this.#raw.destroyed || this.#raw.closed) {
        return "closed";
      }

      if (this.#receivedGoAway) {
        return "draining";
      }

      return "open";
    }

    async close() {
      if (this.destroyed) {
        return;
      }

      if (this.closed) {
        return new Promise<void>((resolve) => {
          this.#raw.once("close", () => {
            resolve();
          });
        });
      }

      return new Promise<void>((resolve) => {
        this.#raw.close(resolve);
      });
    }

    destroy(reason: Error) {
      if (this.destroyed) {
        return;
      }

      this.#receivedError ??= reason;
      this.#raw.destroy(reason, constants.NGHTTP2_CANCEL);
    }

    request(headers: OutgoingHttpHeaders, options?: ClientSessionRequestOptions) {
      if (this.state !== "open") {
        throw new Error("HTTP/2 session is not accepting new streams");
      }

      if (this.#streams.size >= this.#maxConcurrentStreams) {
        throw new Error("HTTP/2 session has reached its concurrent stream limit");
      }

      const stream = this.#raw.request(headers, options);

      this.#streams.add(stream);

      stream.once("close", () => {
        this.#streams.delete(stream);

        if (this.#streams.size === 0 && this.#receivedGoAway) {
          this.#raw.close();
        }
      });

      return stream;
    }

    #probeInFlight = false;
    #probeConsecutiveFailures = 0;

    #probe() {
      if (this.closed || this.destroyed || this.#probeInFlight) {
        return;
      }

      this.#probeInFlight = true;

      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("HTTP/2 session PING timeout")), this.#probeTimeoutMs).unref();

        try {
          this.#raw.ping(Buffer.from("01234567"), (error) => {
            clearTimeout(timer);

            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      })
        .then(() => {
          this.#probeInFlight = false;
          this.#probeConsecutiveFailures = 0;

          if (this.state === "open") {
            this.#raw.setTimeout(this.#idleTimeoutMs);
          }
        })
        .catch((error) => {
          this.#probeInFlight = false;
          this.#probeConsecutiveFailures += 1;

          if (this.#probeConsecutiveFailures < this.#probeFailureThreshold) {
            if (this.state === "open") {
              this.#raw.setTimeout(this.#idleTimeoutMs);
            }

            return;
          }

          this.destroy(error instanceof Error ? error : new Error(String(error)));
        });
    }
  }

  export namespace Session {
    export type State = "open" | "draining" | "closed" | "error";

    export interface Options {
      /** How long the session may be idle (no active streams) before a liveness probe is sent. Defaults to 30s. */
      idleTimeoutMs?: number;
      /** How long to wait for a PING acknowledgement before treating a probe as a timeout. Defaults to 3s. */
      probeTimeoutMs?: number;
      /**
       * How many *consecutive* failed probes (timeout or PING error) must occur
       * before the session is destroyed. A single slow/errored probe is common
       * under load and does not imply the connection is dead. Defaults to 3.
       */
      probeFailureThreshold?: number;
      /**
       * Maximum number of concurrent `:connect` streams this session may carry.
       * New `connect()` requests are queued until a slot frees up. Defaults to
       * 100.
       */
      maxConcurrentStreams?: number;
    }
  }
}
