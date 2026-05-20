import { Server as HTTPServer } from "node:http";
import { type Socket, Server as WebSocketServer } from "socket.io";
import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";

export class Server {
  #logger: Logger;

  #httpServer?: HTTPServer;
  #socketServer?: WebSocketServer;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Server");
  }

  async init(options: Server.InitOptions) {
    this.#logger.info("Initializing...");

    const http = new HTTPServer();

    http.listen(3000);

    try {
      await new Promise<void>((resolve, reject) => {
        http.on("error", reject);
        http.on("listening", resolve);
      });
    } catch (error) {
      return this.#logger.errorFrom(error, "Failed to start http server");
    }

    this.#logger.info(`HTTP server listening on port 3000`);

    const socket = new WebSocketServer(http);

    this.#socketServer = socket;
    this.#httpServer = http;

    socket.on("connection", (socket) => {
      options.onConnection(socket);
    });
  }

  async shutdown() {
    this.#logger.info("Shutting down...");

    if (this.#socketServer) {
      await this.#socketServer.close();
    }

    if (this.#httpServer) {
      this.#httpServer.close();
    }
  }
}

export namespace Server {
  export type InitOptions = {
    onConnection: (socket: Socket) => void;
  };
}
