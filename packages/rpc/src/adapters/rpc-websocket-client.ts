import type { Socket } from "socket.io-client";
import type { RPCConnection } from "@/rpc-connection";
import type { RPCMessage } from "@/rpc-message";

export class RPCWebsocketClient implements RPCConnection.Transport {
  #socket: Socket<RPCWebsocketClient.Events, RPCWebsocketClient.Events>;
  #encoder: RPCConnection.Encoder;

  #destroyed = false;

  #boundOnMessage = this.#onMessage.bind(this);
  #boundOnDisconnect = this.#onDisconnect.bind(this);
  #boundOnError = this.#onError.bind(this);

  onMessage?: (message: RPCMessage) => void;
  onDisconnect?: (error?: Error) => void;

  get disconnected() {
    return this.#destroyed || this.#socket.disconnected;
  }

  constructor(socket: Socket<RPCWebsocketClient.Events, RPCWebsocketClient.Events>, encoder: RPCConnection.Encoder) {
    this.#socket = socket;
    this.#encoder = encoder;

    if (!socket.connected) {
      throw new Error("Socket not connected");
    }

    this.#socket.on("rpc.message", this.#boundOnMessage);
    this.#socket.on("disconnect", this.#boundOnDisconnect);
    this.#socket.on("connect_error", this.#boundOnError);
  }

  #onMessage(data: Uint8Array) {
    if (this.#destroyed) return;

    try {
      const parsed = this.#encoder.decode(data);
      this.onMessage?.(parsed);
    } catch (error) {
      this.#handleFatalError(
        new Error(`Failed to decode rpc message: ${error instanceof Error ? error.message : error}`, { cause: error }),
      );
    }
  }

  #onDisconnect(reason: Socket.DisconnectReason) {
    if (reason !== "io client disconnect" && reason !== "io server disconnect") {
      this.#destroy(new Error(`Client transport disconnected abnormally: ${reason}`));
    } else {
      this.#destroy();
    }
  }

  #onError(error: Error) {
    this.#handleFatalError(error);
  }

  #handleFatalError(error: Error) {
    if (this.#destroyed) {
      return;
    }

    if (!this.#socket.disconnected) {
      this.#socket.disconnect();
    }

    this.#destroy(error);
  }

  #destroy(error?: Error) {
    if (this.#destroyed) return;
    this.#destroyed = true;

    this.#socket.off("rpc.message", this.#boundOnMessage);
    this.#socket.off("disconnect", this.#boundOnDisconnect);
    this.#socket.off("connect_error", this.#boundOnError);

    this.onDisconnect?.(error);
  }

  send(message: RPCMessage) {
    if (this.disconnected) {
      return this.#handleFatalError(new Error("Cannot send message: transport is disconnected"));
    }

    let data: Uint8Array;

    try {
      data = this.#encoder.encode(message);
    } catch (error) {
      return this.#handleFatalError(
        new Error(`Failed to encode rpc message: ${error instanceof Error ? error.message : error}`, { cause: error }),
      );
    }

    try {
      this.#socket.emit("rpc.message", data);
    } catch (error) {
      return this.#handleFatalError(
        new Error(`Failed to emit rpc message: ${error instanceof Error ? error.message : error}`, { cause: error }),
      );
    }
  }
}

export namespace RPCWebsocketClient {
  export type Events = {
    "rpc.message": (data: Uint8Array) => void;
  };
}
