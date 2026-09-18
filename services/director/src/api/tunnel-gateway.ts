import { Container } from "@aw/container";
import type { Logger } from "@aw/logging";
import type { Authenticator } from "@/internal/authenticator";
import { HTTPServer } from "@/internal/http-server";
import type { Leases } from "@/internal/leases";

export class TunnelGateway extends Container.ServiceConstructable {
  #authenticator: Authenticator;
  #logger: Logger;
  #server: HTTPServer;

  constructor(...deps: [Authenticator, Logger, HTTPServer, Leases]) {
    super();

    this.#authenticator = deps[0];
    this.#logger = deps[1].namespace("TunnelIngress");
    this.#server = deps[2];
  }

  get routes() {
    return [
      {
        kind: "upgrade",
        method: HTTPServer.Method.Any,
        path: "link/:project/**:rest",
        handler: (context) => this.#handler(context),
      },
      {
        kind: "request",
        method: HTTPServer.Method.Any,
        path: "link/:project/**:rest",
        handler: (context) => this.#handler(context),
      },
    ] satisfies HTTPServer.Mux.Route[];
  }

  async #reject(context: HTTPServer.UpgradeRouteContext | HTTPServer.RequestRouteContext, status: number, message: string) {
    try {
      context.socket.write(
        `HTTP/1.1 ${status} ${statusText}\r\n` +
          `Content-Type: text/plain\r\n` +
          `Content-Length: ${Buffer.byteLength(message)}\r\n` +
          `Connection: close\r\n` +
          `\r\n` +
          message,
      );
    } catch {
      // Socket may already be closing.
    }

    context.socket.destroy();
  }

  async #handler(context: HTTPServer.UpgradeRouteContext | HTTPServer.RequestRouteContext) {
    // const headers = new Headers();
    // for (const [key, value] of Object.entries(context.req.headers)) {
    //   if (value === undefined) continue;
    //   if (Array.isArray(value)) {
    //     for (const v of value) headers.append(key, v);
    //   } else {
    //     headers.set(key, value);
    //   }
    // }
    // // Authenticate — only supervisors may join a tunnel pool.
    // let identity: Authenticator.Identity;
    // try {
    //   identity = await this.#authenticator.authenticate(headers);
    // } catch (error) {
    //   this.#logger.warn("Tunnel upgrade authentication failed", {
    //     err: error,
    //   });
    //   return this.#reject(context, 401, "Unauthorized", "Authentication required");
    // }
    // if (identity.case !== "supervisor") {
    //   this.#logger.warn("Tunnel upgrade rejected — identity is not a supervisor", {
    //     case: identity.case,
    //   });
    //   return this.#reject(context, 403, "Forbidden", "Only supervisors can establish tunnel connections");
    // }
    // this.#doTunnelUpgrade(identity.supervisorId, context);
  }

  protected override async initialize(_: AbortSignal) {
    this.#server.route({
      kind: "upgrade",
      method: HTTPServer.Method.Any,
      path: "link/:project/**:rest",
      handler: (context) => this.#handler(context),
    });
    this.#server.route({
      kind: "request",
      method: HTTPServer.Method.Any,
      path: "link/:project/**:rest",
      handler: (context) => this.#handler(context),
    });
  }
}
