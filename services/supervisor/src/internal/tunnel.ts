import { TunnelClient } from "@aw/vm-director/tunnel";
import { Container } from "@/helpers/container";
import { Controller } from "@/internal/controller";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

export class Tunnel {
  #client?: TunnelClient;
  #logger: Logger;
  #variables: Variables;
  #controller: Controller;
  #abort?: AbortController;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Tunnel");
    this.#variables = Container.inject(Variables);
    this.#controller = Container.inject(Controller);
  }

  get client() {
    if (!this.#client) {
      throw new Error("Tunnel has not been initialized. Call init() first.");
    }

    return this.#client;
  }

  async init() {
    if (this.#client) {
      throw new Error("Tunnel is already initialized.");
    }

    const supervisorId = this.#variables.get("AW_SUPERVISOR_ID");
    const supervisorPrivateKey = this.#variables.get("AW_SUPERVISOR_PRIVATE_KEY");
    const baseUrl = this.#variables.get("AW_SUPERVISOR_DIRECTOR_HOST_URL");

    if (!supervisorId) {
      throw new Error("AW_SUPERVISOR_ID is not set.");
    }

    if (!supervisorPrivateKey) {
      throw new Error("AW_SUPERVISOR_PRIVATE_KEY is not set.");
    }

    if (!baseUrl) {
      throw new Error("AW_SUPERVISOR_DIRECTOR_HOST_URL is not set.");
    }

    this.#abort = new AbortController();

    this.#client = new TunnelClient({
      identity: {
        type: "supervisor",
        id: supervisorId,
        privateKey: supervisorPrivateKey,
      },
      maxConnections: Tunnel.MAX_CONNECTIONS,
      baseUrl,
      targetResolver: (headers) => this.#resolveTarget(headers),
      logger: this.#logger,
    });

    this.#client.start(this.#abort.signal);

    this.#logger.info("Tunnel initialized and started", { baseUrl });
  }

  async close() {
    if (!this.#abort) {
      return;
    }

    this.#abort.abort();
    this.#logger.info("Tunnel closed");
  }

  async #resolveTarget(headers: Headers): Promise<URL> {
    const instanceId = headers.get("x-instance-id");

    if (!instanceId) {
      throw new Error("Missing x-instance-id header in tunnel request.");
    }

    const processing = this.#controller.processing(instanceId);

    if (!processing) {
      throw new Error(`No running task found for instance "${instanceId}".`);
    }

    const task = await processing;

    await task.ready;

    return new URL(`http://${task.net.veth.guest.ip}:8000`);
  }
}

export namespace Tunnel {
  export const MAX_CONNECTIONS = 10;
}
