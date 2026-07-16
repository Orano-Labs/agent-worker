import { request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { Transform } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { HTTPParser } from "http-parser-js";
import { default as pump } from "pump";

export class TunnelClient {
  #target: URL;
  #started: boolean;
  #baseUrl: string;
  #project: string;
  #token: string;
  #maxSockets: number;
  #logger: TunnelClient.Logger;

  constructor(options: TunnelClient.Options) {
    this.#baseUrl = options.baseUrl;
    this.#target = options.target;
    this.#started = false;
    this.#project = options.project;
    this.#token = options.token;
    this.#maxSockets = options.maxSockets;
    this.#logger = options.logger;
  }

  start(signal: AbortSignal) {
    signal.throwIfAborted();

    if (this.#started) {
      throw new Error("TunnelClient is already started");
    }

    this.#started = true;

    for (let i = 0; i < this.#maxSockets; i++) {
      this.#createTunnelSocket(signal);
    }
  }

  async #createTunnelSocket(signal: AbortSignal) {
    const target = this.#resolveTarget();

    while (!signal.aborted) {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const url = new URL(`${this.#baseUrl}/tunnel/${this.#project}/${this.#token}`);
        const request = httpRequest(url, {
          headers: {
            connection: "upgrade",
            upgrade: "tunnel",
          },
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
      }).catch((error) => {
        this.#logger.warn("Tunnel connection failed, retrying in 1s", {
          project: this.#project,
          error: String(error),
        });

        return new Promise<void>((resolve) => {
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          const onTimeout = () => {
            signal.removeEventListener("abort", onAbort);
          };
          const timer = setTimeout(onTimeout, 1000);

          signal.addEventListener("abort", onAbort, { once: true });
        });
      });

      if (!socket) {
        continue;
      }

      this.#logger.info("Tunnel socket connected", {
        project: this.#project,
      });

      socket.setKeepAlive(true);

      socket.once("data", (chunk) => {
        socket.pause();

        const remote = target.tls
          ? tlsConnect({
              host: target.hostname,
              port: target.port,
              servername: target.hostname,
              rejectUnauthorized: false,
            })
          : netConnect({ host: target.hostname, port: target.port });

        remote.once("connect", () => {
          socket.unshift(chunk);

          // const rewrite = new HTTPHostRewriteTransform(target.hostname);
          // const stream = rewrite.pipe(remote);

          pump(socket, new HTTPHostRewriteTransform(target.hostname), remote);
          pump(remote, socket);

          socket.resume();
        });

        remote.once("error", (error) => {
          this.#logger.error("Remote connection error", {
            project: this.#project,
            error: String(error),
          });

          socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          socket.destroy(error);
        });
      });

      // Wait for this socket to close before reconnecting.
      await new Promise<void>((resolve) => {
        const cleanup = () => {
          socket.removeListener("close", onClose);
          socket.removeListener("error", onError);
          signal.removeEventListener("abort", onAbort);
        };

        const onClose = () => {
          cleanup();
          resolve();
        };

        const onError = () => {
          socket.destroy();
          cleanup();
          resolve();
        };

        const onAbort = () => {
          if (!socket.destroyed) {
            socket.destroy();
          }
          cleanup();
          resolve();
        };

        socket.once("close", onClose);
        socket.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  #resolveTarget(): { hostname: string; port: number; tls: boolean } {
    const protocol = this.#target.protocol.replace(":", "");

    return {
      hostname: this.#target.hostname,
      port: this.#target.port ? Number.parseInt(this.#target.port, 10) : protocol === "https" ? 443 : 80,
      tls: protocol === "https",
    };
  }
}

/**
 * Rewrites the {@code Host} header of every HTTP request that passes through.
 *
 * It uses {@link http-parser-js} to parse the incoming byte stream.  When the
 * request headers are complete it reconstructs the request line + headers with
 * the Host value replaced by {@code targetHost}, then switches to transparent
 * passthrough for the body (and for WebSocket frames after an HTTP upgrade).
 *
 * Because the parser tracks message boundaries, keep-alive connections with
 * multiple consecutive HTTP requests are handled correctly — each request is
 * rewritten independently.
 */
class HTTPHostRewriteTransform extends Transform {
  #targetHost: string;
  #parser: InstanceType<typeof HTTPParser>;

  constructor(targetHost: string) {
    super();
    this.#targetHost = targetHost;
    this.#parser = new HTTPParser(HTTPParser.REQUEST);

    // Called once per HTTP request when all headers have been received.
    // Reconstruct the request-line + headers with the Host overwritten.
    this.#parser[HTTPParser.kOnHeadersComplete] = (info) => {
      const method = HTTPParser.methods[info.method];
      const headers = info.headers;

      // Replace or inject the Host header.
      let hostIndex = -1;

      for (let i = 0; i < headers.length; i += 2) {
        if (headers[i].toLowerCase() === "host") {
          hostIndex = i;
          break;
        }
      }

      if (hostIndex !== -1) {
        headers[hostIndex + 1] = this.#targetHost;
      } else {
        headers.push("Host", this.#targetHost);
      }

      // Serialise the modified request headers.
      const payloadLines: string[] = [];

      payloadLines.push(`${method} ${info.url} HTTP/${info.versionMajor}.${info.versionMinor}`);

      for (let i = 0; i < headers.length; i += 2) {
        payloadLines.push(`${headers[i]}: ${headers[i + 1]}`);
      }

      const payload = `${payloadLines.join("\r\n")}\r\n\r\n`;

      this.push(Buffer.from(payload, "latin1"));

      // Return 0 to tell the parser we handle the body ourselves.
      return 0;
    };

    // Body chunks are forwarded untouched.
    this.#parser[HTTPParser.kOnBody] = (chunk, start, len) => {
      this.push(chunk.subarray(start, start + len));
    };
  }

  override _transform(chunk: Buffer, _encoding: string, callback: () => void): void {
    let offset = 0;

    // Feed data to the parser byte by byte or in consumed-sized steps.
    // The parser calls the callbacks above which push() to the readable side.
    while (offset < chunk.length) {
      const slice = offset === 0 ? chunk : chunk.subarray(offset);
      const nparsed = this.#parser.execute(slice);

      if (nparsed instanceof Error) {
        // Unparseable data — forward as-is so it doesn't get lost.
        this.push(slice);
        break;
      }

      if (nparsed === 0) {
        break;
      }

      offset += nparsed;
    }

    callback();
  }

  override _flush(callback: () => void): void {
    // Signal end-of-stream to the parser so it can flush any remaining data.
    this.#parser.finish();
    callback();
  }
}

export namespace TunnelClient {
  export type Logger = {
    [k in "info" | "warn" | "error" | "debug"]: (message: string, context: Record<string, unknown>) => void;
  };

  export type Options = {
    baseUrl: string;
    project: string;
    token: string;
    target: URL;
    logger: Logger;
    maxSockets: number;
  };
}
