import { TunnelClient } from "@aw/vm-director/tunnel";
import { Container } from "@/helpers/container";
import { Controller } from "@/internal/controller";
import { Logger } from "@/internal/logger";
import type { Orchestrator } from "@/internal/orchestrator";
import { Terminator } from "./terminator";

export class Tunnel {
  #client?: TunnelClient;
  #logger: Logger;
  #controller: Controller;
  #terminator: Terminator;

  constructor() {
    this.#logger = Container.inject(Logger).prefix("Tunnel");
    this.#controller = Container.inject(Controller);
    this.#terminator = Container.inject(Terminator);
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

    const supervisorId = process.env.AW_SUPERVISOR_ID;
    const supervisorPrivateKey = process.env.AW_SUPERVISOR_PRIVATE_KEY;
    const baseUrl = process.env.AW_SUPERVISOR_DIRECTOR_HOST_URL;

    if (!supervisorId) {
      throw new Error("AW_SUPERVISOR_ID is not set.");
    }

    if (!supervisorPrivateKey) {
      throw new Error("AW_SUPERVISOR_PRIVATE_KEY is not set.");
    }

    if (!baseUrl) {
      throw new Error("AW_SUPERVISOR_DIRECTOR_HOST_URL is not set.");
    }

    const ctrl = new AbortController();

    this.#client = new TunnelClient({
      identity: {
        type: "supervisor",
        id: supervisorId,
        privateKey: supervisorPrivateKey,
      },
      maxConnections: 1,
      baseUrl,
      targetResolver: (headers) => this.#resolveTarget(headers),
      logger: this.#logger,
    });

    this.#client.start(ctrl.signal);

    this.#logger.info("Tunnel initialized and started", { baseUrl });

    this.#terminator.register(async () => {
      ctrl.abort();
    });
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

  async #waitForProcessing(instanceId: string): Promise<Orchestrator.Task> {
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
