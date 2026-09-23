import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { Client, SupervisorPortalPB } from "@aw/vm-director/sdk";
import { createGrpcWebTransport } from "@connectrpc/connect-node";

export class Director extends Container.ServiceConstructable {
  #client?: Client;
  #host?: string;
  #identity?: Readonly<Client.Identity>;
  #processId: string;

  #environment: Environment;
  #logger: Logger;

  constructor(...deps: [Environment, Logger]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("Director");
    this.#processId = crypto.randomUUID();
  }

  get client() {
    if (!this.#client) {
      throw new Error("Director client has not been initialized. Call init() first.");
    }

    return this.#client;
  }

  get host() {
    if (!this.#host) {
      throw new Error("Director host has not been initialized. Call init() first.");
    }

    return this.#host;
  }

  get identity() {
    if (!this.#identity) {
      throw new Error("Director identity has not been initialized. Call init() first.");
    }

    return this.#identity;
  }

  get processId() {
    return this.#processId;
  }

  protected override async initialize(signal: AbortSignal) {
    const supervisorId = this.#environment.get("ID", true);
    const supervisorPrivateKey = this.#environment.get("PRIVATE_KEY", true);
    const baseUrl = this.#environment.get("DIRECTOR_HOST_URL", true);

    const transport = createGrpcWebTransport({
      baseUrl: `${baseUrl}/grpc`,
      httpVersion: "1.1",
    });

    const identity: Client.Identity = {
      type: "supervisor",
      id: supervisorId,
      privateKey: supervisorPrivateKey,
    };

    // @ts-expect-error connect-node (CJS) vs @aw/vm-director/sdk (ESM) transport type mismatch
    const client = new Client(transport, identity);
    const portal = client.createSupervisorPortalService();

    const streamController = new AbortController();
    const stream = portal.watch(
      Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceWatchRequestSchema, {
        processId: this.processId,
      }),
      {
        signal: streamController.signal,
      },
    );

    const abort = streamController.abort.bind(streamController);

    signal.addEventListener("abort", abort);

    try {
      for await (const _ of stream) {
        break;
      }
    } finally {
      abort();
      signal.removeEventListener("abort", abort);
    }

    this.#logger.info("Director initialized and connected to supervisor portal", { baseUrl });

    this.#client = client;
    this.#host = baseUrl;
    this.#identity = Object.freeze(identity);
  }

  protected override async dispose() {}
}
