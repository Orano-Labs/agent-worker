import { Agent, type ClientRequestArgs } from "node:http";
import { Duplex } from "node:stream";
import type { Tunnel } from "@/core/tunnel";

export class TunnelAgent extends Agent {
  #tunnel: Tunnel;

  constructor(tunnel: Tunnel) {
    super({
      keepAlive: true,
    });

    this.#tunnel = tunnel;
  }

  override createConnection(_: ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void) {
    const socket = this.#tunnel.claimSocket();

    if (!socket) {
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

    callback?.(null, socket);

    return socket;
  }

  override destroy() {
    super.destroy();
  }
}
