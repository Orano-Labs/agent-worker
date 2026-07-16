import { Agent, type ClientRequestArgs } from "node:http";
import { Duplex } from "node:stream";
import type { Tunnel } from "@/core/tunnel";
import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";

export class TunnelAgent extends Agent {
  #logger: Logger;
  #tunnel: Tunnel;

  constructor(tunnel: Tunnel) {
    super({
      keepAlive: false,
    });

    this.#logger = Container.inject(Logger).scope("TunnelAgent");
    this.#tunnel = tunnel;
  }

  override createConnection(_: ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void) {
    const socket = this.#tunnel.claimSocket();

    if (!socket) {
      this.#logger.debug("No available tunnel socket for agent connection", {
        project: this.#tunnel.project,
      });

      const err = new Error(`No available tunnel connections for project "${this.#tunnel.project}"`);

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

    this.#logger.debug("Tunnel agent claimed socket for connection", {
      project: this.#tunnel.project,
    });

    callback?.(null, socket);

    return socket;
  }
}
