import { io } from "socket.io-client";

import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

export class Tunnel {
  #variables: Variables;
  #logger: Logger;
  #cli: CommandLine;

  #socket?: Tunnel.Socket;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Tunnel");
    this.#variables = Container.inject(Variables);
    this.#cli = Container.inject(CommandLine);
  }

  async init(options: Tunnel.InitOptions) {
    if (!this.#cli.register) {
      return this.#logger.info("Register flag is false, skipping tunnel initialization");
    }

    this.#logger.info("Initializing...");

    const url = this.#variables.get("VM_AGENT_REGISTRY_URL");

    if (!url) {
      return this.#logger.error("Registry url not set");
    }

    try {
      new URL(url);
    } catch {
      return this.#logger.error(`Invalid registry url: ${url}`);
    }

    const token = this.#variables.get("VM_AGENT_REGISTRY_AUTH_TOKEN");

    if (!token) {
      return this.#logger.error("Registry auth token not set");
    }

    const socket = io(url, {
      auth: {
        token,
      },
      transports: ["websocket"],
      timeout: 1000 * 3,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socket.on("connect", () => {
      this.#logger.info("Tunnel connected");

      options.onConnect(socket);
    });

    socket.on("connect_error", (error) => {
      this.#logger.error(`Socket connection error: ${error.message}`);
    });

    socket.on("disconnect", (reason) => {
      this.#logger.error(`Socket disconnected: ${reason}`);

      // 需要忽略客户端的主动关闭；
      if (this.#socket && reason !== "io client disconnect") {
        this.#logger.info("Reconnecting...");
        this.#socket.connect();
      }
    });

    this.#socket = socket;
  }

  async shutdown() {
    this.#logger.info("Shutting down...");
    this.#socket?.close();
  }
}

export namespace Tunnel {
  export type Socket = ReturnType<typeof io>;

  export type InitOptions = {
    onConnect: (socket: Socket) => void;
  };
}
