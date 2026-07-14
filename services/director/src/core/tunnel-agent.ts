import { Agent, type ClientRequestArgs } from "node:http";
import type { Duplex } from "node:stream";
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

      return null;
    }

    callback?.(null, socket);

    return socket;
  }

  override destroy() {
    super.destroy();
  }
}
