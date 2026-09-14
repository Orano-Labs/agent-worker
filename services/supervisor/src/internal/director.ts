import { randomUUID } from "node:crypto";
import { Container } from "@aw/container";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { Client, SupervisorPortalPB } from "@aw/vm-director/sdk";
import { createGrpcWebTransport } from "@connectrpc/connect-node";

export class Director extends Container.ServiceConstructable {
  #client?: Client;
  #host?: string;
  #identity?: Readonly<Client.Identity>;
  #processId?: string;

  #environment: Environment;
  #logger: Logger;

  #heartbeat?: {
    controller: AbortController;
    loop: Promise<void>;
  };

  constructor(...deps: [Environment, Logger]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("Director");
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
    if (!this.#processId) {
      throw new Error("Director process id has not been initialized. Call init() first.");
    }

    return this.#processId;
  }

  async #startHeartbeatLoop(heartbeat: (signal?: AbortSignal) => Promise<void>, signal: AbortSignal) {
    while (true) {
      if (signal.aborted) {
        return;
      }

      try {
        await heartbeat(signal);
      } catch (error) {
        this.#logger.error("Supervisor portal heartbeat failed", { err: error });
      }

      await this.#sleep(3_000, signal);
    }
  }

  async #sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) {
        return resolve();
      }

      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
    });
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

    // 进程每次启动生成唯一 ID,随心跳上报;
    // Director 据此判断 Supervisor 是否重启,并及时销毁遗留的假死 Tunnel Socket。
    this.#processId = randomUUID();

    const heartbeat = async (signal?: AbortSignal) => {
      return portal
        .heartbeat(
          Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceHeartbeatRequestSchema, {
            processId: this.#processId!,
          }),
          {
            signal,
          },
        )
        .then(() => {
          this.#client = client;
          this.#host = baseUrl;
          this.#identity = Object.freeze(identity);
        });
    };

    try {
      await heartbeat(signal);
    } catch (error) {
      throw new Error("Failed to establish initial connection to supervisor portal.", { cause: error });
    }

    this.#logger.info("Director initialized and connected to supervisor portal", { baseUrl });

    signal.throwIfAborted();

    const controller = new AbortController();
    const loop = this.#startHeartbeatLoop(heartbeat, controller.signal);

    this.#heartbeat = { controller, loop };
  }

  protected override async dispose() {
    const heartbeat = this.#heartbeat;

    if (!heartbeat) {
      return;
    }

    this.#heartbeat = undefined;
    heartbeat.controller.abort();

    return heartbeat.loop;
  }
}
