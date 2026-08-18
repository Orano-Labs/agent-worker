import { TunnelClient } from "@aw/vm-director/tunnel";
import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";

export class Tunnel {
  #client: TunnelClient;
  #logger: Logger;
  #controller: AbortController;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Tunnel");
    this.#client = new TunnelClient({
      identity: {
        type: "supervisor",
        id: "rcguu1932dfrw43o324v52my",
        privateKey: "302e020100300506032b6570042204206424dd57348652833a219457d053315755efc4a5311ebfe026bcca257752de52",
      },
      maxConnections: 100,
      baseUrl: "http://192.168.5.2:3008",
      targetResolver: () => {
        return new URL("https://echo.websocket.org/");
      },
      logger: this.#logger,
    });
    this.#controller = new AbortController();
  }

  async init() {
    this.#client.start(this.#controller.signal);
  }

  async close() {
    this.#controller.abort();
  }
}

export namespace Tunnel {}
