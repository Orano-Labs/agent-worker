import { type ClientRequestArgs, Agent as HTTPAgent, type IncomingMessage, request, type ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import type { Logger } from "@aw/logging";
import { default as pump } from "pump";
import type { Leases } from "@/internal/leases";

export class Tunnel {
  #logger: Logger;
  #supervisor: string;
  #lease: Leases.Lease;

  #agent: Tunnel.Agent;

  constructor(logger: Logger, supervisor: string, lease: Leases.Lease) {
    this.#logger = logger.namespace(`Tunnel.Gateway(${supervisor})`);
    this.#supervisor = supervisor;
    this.#lease = lease;

    this.#agent = new Tunnel.Agent(this, logger);

    this.#logger.debug("Tunnel created", {
      supervisor,
    });
  }

  get supervisor() {
    return this.#supervisor;
  }

  get totalConnections() {
    return this.#lease.totalSockets;
  }

  get idleConnections() {
    return this.#lease.idleSockets;
  }

  get activeConnections() {
    return this.#lease.activeSockets;
  }

  connect(socket: Duplex) {
    return this.#lease.addSocket(socket);
  }

  claimSocket() {
    return this.#lease.claimSocket();
  }

  releaseSocket(socket: Duplex) {
    this.#lease.releaseSocket(socket);
  }

  #reason(status: number): string {
    switch (status) {
      case 502:
        return "Bad Gateway";
      case 503:
        return "Service Unavailable";
      default:
        return "Error";
    }
  }

  handleHttpRequest(clientReq: IncomingMessage, clientRes: ServerResponse, path: string) {
    this.#logger.debug("Proxying HTTP request through tunnel", {
      method: clientReq.method,
      path,
    });

    clientReq.once("error", (err) => {
      this.#logger.debug("Client request error during proxy", {
        err,
      });

      if (!clientRes.headersSent) {
        clientRes.writeHead(502, this.#reason(502));
        clientRes.end("Bad Gateway");
      }
    });

    const req = request({ agent: this.#agent, headers: clientReq.headers, method: clientReq.method, path: path }, (res) => {
      clientRes.writeHead(res.statusCode ?? 0, res.headers);

      pump(res, clientRes, (error) => {
        if (error) {
          this.#logger.warn("Tunnel response stream error", {
            method: clientReq.method,
            path,
            err: error,
          });
        }
      });
    });

    pump(clientReq, req, (error) => {
      if (error) {
        this.#logger.warn("Tunnel request stream error", {
          method: clientReq.method,
          path,
          err: error,
        });
      }
    });
  }

  handleHttpUpgrade(clientReq: IncomingMessage, clientSocket: Duplex, head: Buffer, path: string) {
    this.#logger.debug("Handling HTTP upgrade through tunnel", {
      method: clientReq.method,
      path,
    });

    const tunnelSocket = this.claimSocket();

    if (!tunnelSocket) {
      this.#logger.debug("No available tunnel socket for upgrade");

      clientSocket.write(
        `HTTP/1.1 503 ${this.#reason(503)}\r\n` +
          "Content-Type: text/plain\r\n" +
          "Connection: close\r\n" +
          "\r\n" +
          "No available tunnel connections",
      );
      clientSocket.destroy();

      return;
    }

    const headerLines: string[] = [];

    for (const [key, value] of Object.entries(clientReq.headers)) {
      if (value === undefined) continue;

      if (Array.isArray(value)) {
        for (const v of value) {
          headerLines.push(`${key}: ${v}`);
        }
      } else {
        headerLines.push(`${key}: ${value}`);
      }
    }

    tunnelSocket.write(`${clientReq.method} ${path} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`);

    if (head.length > 0) {
      tunnelSocket.write(head);
    }

    pump(tunnelSocket, clientSocket, (error) => {
      if (error) {
        this.#logger.warn("Tunnel upgrade socket->client stream error", {
          method: clientReq.method,
          path,
          err: error,
        });
      }
    });

    pump(clientSocket, tunnelSocket, (error) => {
      if (error) {
        this.#logger.warn("Tunnel upgrade client->socket stream error", {
          method: clientReq.method,
          path,
          err: error,
        });
      }
    });
  }
}

export namespace Tunnel {
  export class Agent extends HTTPAgent {
    #logger: Logger;
    #gateway: Tunnel;

    constructor(gateway: Tunnel, logger: Logger) {
      super({
        keepAlive: false,
      });

      this.#logger = logger.namespace("Agent");
      this.#gateway = gateway;
    }

    override createConnection(_: ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void) {
      const socket = this.#gateway.claimSocket();

      if (!socket) {
        this.#logger.debug("No available tunnel socket for agent connection");

        const err = new Error(`No available tunnel connections.`);

        callback?.(err, undefined as unknown as Duplex);

        // Return a destroyed dummy so Node's HTTP internals don't crash
        // while the callback propagates the error asynchronously.
        const dummy = new Duplex({
          read() {},
          write(_chunk, _enc, cb) {
            cb();
          },
        });

        dummy.destroy();

        return dummy;
      }

      this.#logger.debug("Tunnel agent claimed socket for connection");

      callback?.(null, socket);

      return socket;
    }
  }

  export type HandleHttpRequestOptions = {
    req: IncomingMessage;
    res: ServerResponse;
    path: string;
    routingKey: string;
  };

  export type HandleHttpUpgradeOptions = {
    req: IncomingMessage;
    socket: Duplex;
    head: Buffer;
    path: string;
    routingKey: string;
  };
}
