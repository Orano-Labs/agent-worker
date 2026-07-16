import { EventEmitter } from "node:events";
import { type IncomingMessage, type RequestOptions, request, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { default as pump } from "pump";
import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";
import { TunnelAgent } from "./tunnel-agent";

export class Tunnel extends EventEmitter<Tunnel.EventMap> {
  static readonly OFFLINE_TIMEOUT_MS = 30_000;

  #logger: Logger;
  #token: string;
  #project: string;
  #supervisor: string;
  #connectedSockets: number;
  #sockets: Duplex[];
  #offlineTimer: NodeJS.Timeout | null = null;

  #agent: TunnelAgent;

  constructor(project: string, token: string, supervisor: string) {
    super();

    this.#logger = Container.inject(Logger).scope("Tunnel");
    this.#project = project;
    this.#token = token;
    this.#supervisor = supervisor;
    this.#connectedSockets = 0;
    this.#sockets = [];

    this.#agent = new TunnelAgent(this);

    this.#logger.debug("Tunnel created", {
      project,
      supervisor,
    });
  }

  get project() {
    return this.#project;
  }

  get token() {
    return this.#token;
  }

  get supervisor() {
    return this.#supervisor;
  }

  connect(socket: Duplex) {
    if (this.#connectedSockets >= Tunnel.MAX_TCP_SOCKETS) {
      this.#logger.debug("Tunnel connection pool is full, rejecting new socket", {
        project: this.#project,
        connectedSockets: this.#connectedSockets,
        maxSockets: Tunnel.MAX_TCP_SOCKETS,
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
        project: this.#project,
        connectedSockets: this.#connectedSockets,
      });

      if (this.#connectedSockets === 0 && !this.#offlineTimer) {
        this.#logger.debug("Last socket closed — starting offline timeout", {
          project: this.#project,
          timeoutMs: Tunnel.OFFLINE_TIMEOUT_MS,
        });

        this.#offlineTimer = setTimeout(() => {
          this.#offlineTimer = null;
          this.#logger.debug("Offline timeout expired — tunnel offline", {
            project: this.#project,
          });

          this.emit("offline");
        }, Tunnel.OFFLINE_TIMEOUT_MS);
      }
    };

    socket.once("close", onClose);
    socket.once("error", (err) => {
      this.#logger.debug("Socket error, destroying", {
        project: this.#project,
        err,
      });

      socket.destroy();
    });

    // Clear any pending offline timeout — a new socket is connecting.
    if (this.#offlineTimer) {
      clearTimeout(this.#offlineTimer);

      this.#offlineTimer = null;
      this.#logger.debug("Offline timeout cancelled — new socket arrived", {
        project: this.#project,
      });
    }

    if (this.#connectedSockets === 0) {
      this.#logger.debug("Tunnel coming online with first socket", {
        project: this.#project,
      });

      this.emit("online");
      this.emit("connect", socket);
    }

    this.#connectedSockets += 1;
    this.#sockets.push(socket);

    this.#logger.debug("Socket attached to tunnel", {
      project: this.#project,
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
        project: this.#project,
        remaining: this.#connectedSockets,
      });

      socket.destroy();
    }
  }

  destroy() {
    this.#logger.debug("Destroying tunnel", {
      project: this.#project,
      connectedSockets: this.#connectedSockets,
    });

    if (this.#offlineTimer) {
      clearTimeout(this.#offlineTimer);
      this.#offlineTimer = null;
    }

    for (const socket of this.#sockets) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }

  handleHttpRequest(clientReq: IncomingMessage, clientRes: ServerResponse, path: string) {
    this.#logger.debug("Proxying HTTP request through tunnel", {
      project: this.#project,
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
        project: this.#project,
        err,
      });

      if (!clientRes.headersSent) {
        clientRes.writeHead(502, this.#reason(502));
        clientRes.end("Bad Gateway");
      }
    });

    pump(clientReq, req);
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

  handleHttpUpgrade(clientReq: IncomingMessage, clientSocket: Duplex, head: Buffer, path: string): void {
    this.#logger.debug("Handling HTTP upgrade through tunnel", {
      project: this.#project,
      method: clientReq.method,
      path,
    });

    const tunnelSocket = this.claimSocket();

    if (!tunnelSocket) {
      this.#logger.debug("No available tunnel socket for upgrade", {
        project: this.#project,
      });

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
  export type EventMap = {
    connect: [Duplex];
    online: [];
    offline: [];
  };

  export const MAX_TCP_SOCKETS = 100;
}
