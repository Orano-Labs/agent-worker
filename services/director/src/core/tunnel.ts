import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";
import { default as pump } from "pump";
import { TunnelAgent } from "./tunnel-agent";

export class Tunnel extends EventEmitter<Tunnel.EventMap> {
  #token: string;
  #project: string;
  #connectedSockets: number;
  #sockets: Duplex[];
  #agent: TunnelAgent;

  constructor(project: string, token: string) {
    super();

    this.#project = project;
    this.#token = token;
    this.#connectedSockets = 0;
    this.#sockets = [];
    this.#agent = new TunnelAgent(this);
  }

  get project() {
    return this.#project;
  }

  get token() {
    return this.#token;
  }

  get agent() {
    return this.#agent;
  }

  connect(socket: Duplex) {
    if (this.#connectedSockets >= Tunnel.MAX_TCP_SOCKETS) {
      return {
        status: 503,
        message: "Tunnel connection pool is full",
      };
    }

    socket.on("data", console.log);

    const onClose = () => {
      this.#connectedSockets -= 1;

      const idx = this.#sockets.indexOf(socket);

      if (idx >= 0) {
        this.#sockets.splice(idx, 1);
      }

      if (this.#connectedSockets <= 0) {
        this.emit("offline");
      }
    };

    socket.once("close", onClose);
    socket.once("error", () => socket.destroy());

    if (this.#connectedSockets === 0) {
      this.emit("online");
      this.emit("connect", socket);
    }

    this.#connectedSockets += 1;
    this.#sockets.push(socket);

    return null;
  }

  claimSocket() {
    while (this.#sockets.length > 0) {
      const socket = this.#sockets.shift()!;

      if (!socket.destroyed && socket.writable) {
        return socket;
      }
    }

    return null;
  }

  destroy() {
    this.#agent.destroy();

    for (const socket of this.#sockets) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }

  handleHttpRequest(clientReq: IncomingMessage, clientRes: ServerResponse, path: string) {
    const proxyReq = httpRequest({
      method: clientReq.method,
      path,
      headers: clientReq.headers,
      agent: this.#agent,
    });

    proxyReq.once("error", (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "text/plain" });
      }

      clientRes.end(`Tunnel proxy error: ${err.message}`);
    });

    proxyReq.once("response", (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);

      pump(proxyRes, clientRes, (err) => {
        if (err && !clientRes.headersSent) {
          clientRes.writeHead(502, { "Content-Type": "text/plain" });
          clientRes.end(`Tunnel proxy error: ${err.message}`);
        }
      });
    });

    pump(clientReq, proxyReq);
  }

  handleHttpUpgrade(clientReq: IncomingMessage, clientSocket: Duplex, head: Buffer, path: string): void {
    const tunnelSocket = this.claimSocket();

    if (!tunnelSocket) {
      clientSocket.write(
        "HTTP/1.1 503 Service Unavailable\r\n" +
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
