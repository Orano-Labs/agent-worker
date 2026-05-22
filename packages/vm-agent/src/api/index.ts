import { RPCConnection, RPCHandler } from "@aw/rpc";
import { RPCWebsocketClient } from "@aw/rpc/websocket/client";
import { RPCWebsocketServer } from "@aw/rpc/websocket/server";
import { Socket as ServerSideSocket } from "socket.io";
import { Socket as ClientSideSocket } from "socket.io-client";
import { FSImplementation } from "@/api/implementation/fs";
import { FSProtocol } from "@/api/protocol/fs";
import { APIUtils } from "@/api/utils";
import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";

export class API {
  #handler: RPCHandler;

  #logger: Logger;

  constructor() {
    this.#logger = Container.inject(Logger).scope("API");

    this.#handler = new RPCHandler();

    this.#handler.register("vm-agent.fs", FSProtocol.methods, new FSImplementation());
  }

  createTransport(socket: ServerSideSocket | ClientSideSocket) {
    if (socket instanceof ServerSideSocket) {
      return new RPCWebsocketServer(socket, APIUtils.encoder);
    }

    if (socket instanceof ClientSideSocket) {
      // @ts-expect-error
      return new RPCWebsocketClient(socket, APIUtils.encoder);
    }

    throw new Error("Invalid socket type");
  }

  connect(socket: ServerSideSocket | ClientSideSocket) {
    const logger = this.#logger.scope(`RPCConnection:${socket instanceof ServerSideSocket ? "Server" : "Tunnel"}`);

    return new RPCConnection(this.createTransport(socket), {
      handler: this.#handler.createHandler(),
      debugger: {
        debug: (message, context) => {
          logger.debug(message, {
            context,
            socket: {
              id: socket.id,
            },
          });
        },
      },
    });
  }
}

export namespace API {}
