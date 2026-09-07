import { randomUUID } from "node:crypto";
import { Client, SupervisorPortalPB } from "@aw/vm-director/sdk";
import { createGrpcWebTransport } from "@connectrpc/connect-node";
import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";

export class Director {
  #client?: Client;
  #host?: string;
  #identity?: Readonly<Client.Identity>;
  #processId?: string;
  #logger: Logger;

  constructor() {
    this.#logger = Container.inject(Logger).prefix("Director");
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

  async #startHeartbeatLoop(heartbeat: () => Promise<void>) {
    while (true) {
      try {
        await heartbeat();
      } catch (error) {
        this.#logger.errorFrom(error, "Supervisor portal heartbeat failed");
      }

      await this.#sleep(3_000);
    }
  }

  async #sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async init() {
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

    const transport = createGrpcWebTransport({
      baseUrl: `${baseUrl}/grpc`,
      httpVersion: "1.1",
    });

    // @ts-expect-error
    const client = new Client(transport, { type: "supervisor", id: supervisorId, privateKey: supervisorPrivateKey });
    const portal = client.createSupervisorPortalService();

    // 进程每次启动生成唯一 ID,随心跳上报;
    // Director 据此判断 Supervisor 是否重启,并及时销毁遗留的假死 Tunnel Socket。
    this.#processId = randomUUID();

    const heartbeat = async () => {
      return portal
        .heartbeat(
          Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceHeartbeatRequestSchema, {
            processId: this.#processId!,
          }),
        )
        .then(() => {
          this.#client = client;
          this.#host = baseUrl;
          this.#identity = Object.freeze({
            type: "supervisor",
            id: supervisorId,
            privateKey: supervisorPrivateKey,
          });
        });
    };

    try {
      await heartbeat();
    } catch (error) {
      throw new Error("Failed to establish initial connection to supervisor portal.", { cause: error });
    }

    void this.#startHeartbeatLoop(heartbeat);

    this.#logger.info("Director initialized and connected to supervisor portal", { baseUrl });
  }
}
