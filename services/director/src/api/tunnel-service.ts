import { ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { Container } from "@aw/container";
import { Logger } from "@aw/logging";
import { Authenticator } from "@/internal/authenticator";
import { HTTPServer } from "@/internal/http-server";
import { Tunnels } from "@/internal/tunnels";

export class SupervisorTunnelService extends Container.ServiceConstructable {
  #http: HTTPServer;
  #authenticator: Authenticator;
  #tunnels: Tunnels;
  #logger: Logger;

  constructor(...deps: [HTTPServer, Authenticator, Tunnels, Logger]) {
    super();

    this.#http = deps[0];
    this.#authenticator = deps[1];
    this.#tunnels = deps[2];
    this.#logger = deps[3].namespace("SupervisorTunnelService");
  }

  protected override async initialize(_signal: AbortSignal) {
    this.#http.router.upgrade("*", "tunnel", (context) => {
      this.#accept(context);
    });

    this.#http.router.upgrade("*", "link/**:rest", (context) => {
      // this.#accept(context);
    });

    this.#http.router.request("*", "link/**:rest", (context) => {
      // this.#accept(context);
    });
  }

  async #accept(context: HTTPServer.Router.UpgradeContext) {
    const headers = new Headers();

    for (const [key, value] of Object.entries(context.req.headers)) {
      if (value === undefined) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          headers.append(key, item);
        }
      } else {
        headers.set(key, value);
      }
    }

    let identity: Authenticator.Identity;

    try {
      identity = await this.#authenticator.authenticate(headers);
    } catch (error) {
      this.#logger.warn("Supervisor tunnel authentication failed.", {
        err: error,
      });

      return this.#rejectUpgrade(context.socket, 401, "Authentication required");
    }

    if (identity.type !== "supervisor") {
      this.#logger.warn("Supervisor tunnel rejected.", {
        identity: identity.type,
      });

      return this.#rejectUpgrade(context.socket, 403, "Only supervisors can establish tunnels");
    }

    let tunnel: Tunnels.Tunnel;

    try {
      tunnel = this.#tunnels.ensure(identity.id);
    } catch (error) {
      this.#logger.warn("Supervisor tunnel service is unavailable.", {
        err: error,
      });

      return this.#rejectUpgrade(context.socket, 503, "Tunnel service is unavailable");
    }

    context.socket.write("HTTP/1.1 101 Switching Protocols\r\n" + "Upgrade: tunnel\r\n" + "Connection: Upgrade\r\n" + "\r\n");

    try {
      await tunnel.upgrade(context.socket);

      this.#logger.debug("Supervisor tunnel connected.", {
        supervisorId: identity.id,
      });
    } catch (error) {
      this.#logger.warn("Supervisor tunnel upgrade failed.", {
        supervisorId: identity.id,
        err: error,
      });

      if (!context.socket.destroyed) {
        context.socket.destroy();
      }
    }
  }

  #rejectUpgrade(socket: Duplex, status: number, message: string) {
    const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 503 ? "Service Unavailable" : "Error";

    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        "Content-Type: text/plain\r\n" +
        `Content-Length: ${Buffer.byteLength(message)}\r\n` +
        "Connection: close\r\n" +
        "\r\n" +
        message,
    );
  }

  #rejectRequest(response: ServerResponse, status: number, message: string) {
    if (!response.headersSent) {
      response.statusCode = status;
      response.statusMessage =
        status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 503 ? "Service Unavailable" : "Error";

      response.setHeaders(
        new Headers({
          "Content-Type": "text/plain",
          "Content-Length": `${Buffer.byteLength(message)}`,
          Connection: "close",
        }),
      );
    }

    if (response.writable) {
      response.end(message);
    }
  }
}
