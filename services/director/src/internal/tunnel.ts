import {
  type ClientRequestArgs,
  Agent as HTTPAgent,
  type IncomingMessage,
  type RequestOptions,
  request,
  type ServerResponse,
} from "node:http";
import { Duplex } from "node:stream";
import { default as pump } from "pump";
import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";

export class Tunnel {
  #logger: Logger;
  #supervisor: string;
  #connectedSockets: number;
  #sockets: Duplex[];
  #maxSockets: number;

  #agent: Tunnel.Agent;

  constructor(supervisor: string, maxSockets: number) {
    this.#logger = Container.inject(Logger).scope(`Tunnel.Gateway(${supervisor})`);
    this.#supervisor = supervisor;
    this.#connectedSockets = 0;
    this.#sockets = [];
    this.#maxSockets = maxSockets;

    this.#agent = new Tunnel.Agent(this);

    this.#logger.debug("Tunnel created", {
      supervisor,
    });
  }

  get supervisor() {
    return this.#supervisor;
  }

  get totalConnections() {
    return this.#connectedSockets;
  }

  get idleConnections() {
    return this.#sockets.length;
  }

  get activeConnections() {
    return Math.max(0, this.#connectedSockets - this.#sockets.length);
  }

  connect(socket: Duplex) {
    if (this.#connectedSockets >= this.#maxSockets) {
      this.#logger.debug("Tunnel connection pool is full, rejecting new socket", {
        connectedSockets: this.#connectedSockets,
      });

      return {
        status: 503,
        message: "Tunnel connection pool is full",
      };
    }

    const onClose = () => {
      this.#connectedSockets = Math.max(0, this.#connectedSockets - 1);

      const idx = this.#sockets.indexOf(socket);

      if (idx >= 0) {
        this.#sockets.splice(idx, 1);
      }

      this.#logger.debug("Socket closed", {
        connectedSockets: this.#connectedSockets,
      });
    };

    socket.once("close", onClose);
    socket.once("error", (err) => {
      this.#logger.debug("Socket error, destroying", {
        err,
      });

      socket.destroy();
    });

    if (this.#connectedSockets === 0) {
      this.#logger.debug("Tunnel coming online with first socket");
    }

    this.#connectedSockets += 1;
    this.#sockets.push(socket);

    this.#logger.debug("Socket attached to tunnel", {
      connectedSockets: this.#connectedSockets,
    });

    return null;
  }

  claimSocket() {
    while (true) {
      const socket = this.#sockets.shift();

      if (!socket) {
        return null;
      }

      // After pruning all should be alive, but check defensively.
      if (!socket.destroyed && socket.writable && socket.readable) {
        return socket;
      }

      this.#logger.debug("Claimed socket was dead on arrival, skipping", {
        remaining: this.#connectedSockets,
      });

      socket.destroy();
    }
  }

  destroy() {
    this.#logger.debug("Destroying tunnel", {
      connectedSockets: this.#connectedSockets,
    });

    for (const socket of this.#sockets) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
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

    const opt: RequestOptions = {
      agent: this.#agent,
      headers: clientReq.headers,
      method: clientReq.method,
      path: path,
    };

    const req = request(opt, (res) => {
      clientRes.writeHead(res.statusCode ?? 0, res.headers);
      pump(res, clientRes);
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

    pump(clientReq, req);
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

    pump(tunnelSocket, clientSocket);
    pump(clientSocket, tunnelSocket);
  }
}

export namespace Tunnel {
  export class Agent extends HTTPAgent {
    #logger: Logger;
    #gateway: Tunnel;

    constructor(gateway: Tunnel) {
      super({
        keepAlive: false,
      });

      this.#logger = Container.inject(Logger).scope("Agent");
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
