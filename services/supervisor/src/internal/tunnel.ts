import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { TunnelClient } from "@aw/vm-director/tunnel";
import type { Controller } from "@/internal/controller";

export class Tunnel extends Container.ServiceConstructable {
  #client?: TunnelClient;
  #controller: Controller;
  #environment: Environment;
  #logger: Logger;
  #abort?: AbortController;

  constructor(...deps: [Environment, Logger, Controller]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("Tunnel");
    this.#controller = deps[2];
  }

  get client() {
    if (!this.#client) {
      throw new Error("Tunnel has not been initialized. Call init() first.");
    }

    return this.#client;
  }

  protected override async initialize(signal: AbortSignal) {
    signal.throwIfAborted();

    if (this.#client) {
      throw new Error("Tunnel is already initialized.");
    }

    const supervisorId = this.#environment.get("ID", true);
    const supervisorPrivateKey = this.#environment.get("PRIVATE_KEY", true);
    const baseUrl = this.#environment.get("DIRECTOR_HOST_URL", true);

    const ctrl = new AbortController();

    signal.addEventListener("abort", () => ctrl.abort(), { once: true });

    const client = new TunnelClient({
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

    client.start(ctrl.signal);

    this.#client = client;
    this.#abort = ctrl;

    this.#logger.info("Tunnel initialized and started", { baseUrl });
  }

  protected override async dispose() {
    this.#abort?.abort();

    this.#abort = undefined;
    this.#client = undefined;
  }

  async #resolveTarget(headers: Headers): Promise<URL> {
    const instanceId = headers.get("x-instance-id");

    if (!instanceId) {
      throw new Error("Missing x-instance-id header in tunnel request.");
    }

    const task = await this.#waitForProcessing(instanceId);

    return task.ready.then(() => {
      return new URL(`http://${task.net.veth.guest.ip}:8000`);
    });
  }

  async #waitForProcessing(instanceId: string): Promise<Controller.RunningInstance> {
    const deadline = Date.now() + 3000;

    while (Date.now() < deadline) {
      const processing = this.#controller.processing(instanceId);

      if (processing) {
        return processing;
      }

      await this.#sleep(100);
    }

    throw new Error(`No running task found for instance "${instanceId}".`);
  }

  async #sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

export namespace Tunnel {
  export const MAX_CONNECTIONS = 10;
}
