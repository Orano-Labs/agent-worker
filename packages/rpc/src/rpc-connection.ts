import { RPCError } from "@/rpc-error";
import { RPCMessage } from "@/rpc-message";
import { RPCStreamsManager } from "@/rpc-streams-manager";

export class RPCConnection {
  #transport: RPCConnection.Transport;
  #streams: RPCStreamsManager;

  #handler?: RPCConnection.Handler;

  constructor(transport: RPCConnection.Transport, options: RPCConnection.Options) {
    if (transport.onMessage || transport.onClose) {
      throw new Error(`Transport already has handlers`);
    }

    this.#transport = transport;
    this.#handler = options.handler;

    this.#transport.onClose = this.#onClose.bind(this);
    this.#transport.onMessage = this.#onMessage.bind(this);

    this.#streams = new RPCStreamsManager({
      send: (msg) => this.#transport.send(msg),
    });
  }

  #incomingRequests = new Map<string, RPCConnection.IncomingRequest>();
  #outgoingRequests = new Map<string, RPCConnection.OutgoingRequest>();

  #onMessage(message: RPCMessage) {
    if (message.type === "request") {
      this.#onRequest(message);
    } else if (message.type === "response") {
      this.#onResponse(message);
    } else if (message.type === "event") {
      this.#onEvent(message);
    } else {
      //
    }
  }

  #onClose(error?: Error) {
    const e = error || RPCError.createCanceled("Connection closed.");

    for (const request of this.#incomingRequests.values()) {
      request.controller.abort(e);
    }

    for (const deferred of this.#outgoingRequests.values()) {
      deferred.reject(e);
    }

    this.#incomingRequests.clear();
    this.#outgoingRequests.clear();
    this.#streams.destroy(e);
  }

  #onRequest(message: RPCMessage.Request) {
    const controller = new AbortController();

    const request: RPCConnection.IncomingRequest = {
      message,
      controller,
    };

    if (this.#incomingRequests.has(message.id)) {
      return this.#transport.send(
        RPCMessage.createFailureResponse(message.id, {
          code: RPCError.Code.Unimplemented,
          message: `Request already exists: "${message.id}"`,
        }),
      );
    }

    let input: RPCConnection.Content;

    if ("stream" in message.content) {
      let stream: ReadableStream<RPCMessage.Transferable>;

      try {
        stream = this.#streams.createIncoming(message.content.stream, {
          signal: controller.signal,
        });
      } catch (error) {
        return this.#transport.send(
          RPCMessage.createFailureResponse(message.id, RPCError.fromUnknown(error, RPCError.Code.Internal).transferable()),
        );
      }

      input = {
        data: stream,
        metadata: message.metadata,
      };
    } else {
      input = {
        data: message.content.data,
        metadata: message.metadata,
      };
    }

    this.#incomingRequests.set(message.id, request);

    Promise.resolve()
      .then(() => {
        if (!this.#handler) {
          throw RPCError.createUnimplemented("Method not implemented.");
        }

        return this.#handler(input, { signal: controller.signal, id: message.id, method: message.method });
      })
      .then((output) => {
        if (output.data instanceof ReadableStream) {
          let stream: string;

          try {
            stream = this.#streams.createOutgoing(output.data, {
              signal: controller.signal,
            });
          } catch (error) {
            return this.#transport.send(
              RPCMessage.createFailureResponse(message.id, RPCError.fromUnknown(error, RPCError.Code.Internal).transferable()),
            );
          }

          return this.#transport.send(RPCMessage.createSuccessResponse(message.id, { stream }, output.metadata));
        } else {
          return this.#transport.send(RPCMessage.createSuccessResponse(message.id, { data: output.data }, output.metadata));
        }
      })
      .catch((error) => {
        return this.#transport.send(
          RPCMessage.createFailureResponse(message.id, RPCError.fromUnknown(error, RPCError.Code.Internal).transferable()),
        );
      })
      .finally(() => {
        this.#incomingRequests.delete(message.id);
      });
  }

  #onResponse(message: RPCMessage.Response) {
    const deferred = this.#outgoingRequests.get(message.request);

    if (!deferred) {
      return;
    }

    this.#outgoingRequests.delete(message.request);

    if ("error" in message) {
      return deferred.reject(RPCError.fromTransferable(message.error));
    }

    if ("stream" in message.content) {
      try {
        deferred.resolve({
          data: this.#streams.createIncoming(message.content.stream, {
            signal: deferred.signal,
          }),
          metadata: message.metadata,
        });
      } catch (err) {
        deferred.reject(RPCError.fromUnknown(err, RPCError.Code.Internal));
      }
    } else {
      deferred.resolve({
        data: message.content.data,
        metadata: message.metadata,
      });
    }
  }

  #onEvent(message: RPCMessage.Event) {
    if (message.body.type === "request:canceled") {
      const request = this.#incomingRequests.get(message.body.id);

      if (!request) {
        return;
      }

      request.controller.abort(RPCError.createCanceled("Request canceled by remote side."));
    }

    this.#streams.handle(message);
  }

  async invoke(method: string, content: RPCConnection.Content, context?: RPCConnection.InvokeContext) {
    const signal = context?.signal;

    signal?.throwIfAborted();

    const message = RPCMessage.createRequest(method, { data: null }, content.metadata);

    if (content.data instanceof ReadableStream) {
      try {
        message.content = {
          stream: this.#streams.createOutgoing(content.data, {
            signal,
          }),
        };
      } catch (error) {
        throw RPCError.fromUnknown(error, RPCError.Code.Internal);
      }
    } else {
      message.content = { data: content.data };
    }

    return new Promise((resolve, reject) => {
      const handleAbort = (reason: unknown) => {
        this.#outgoingRequests.delete(message.id);
        this.#transport.send(RPCMessage.createRequestCanceledEvent(message.id));

        reject(reason);
      };

      if (signal) {
        signal.addEventListener("abort", handleAbort);
      }

      this.#outgoingRequests.set(message.id, {
        signal,
        message,
        resolve: (responsePayload) => {
          if (signal) {
            signal.removeEventListener("abort", handleAbort);
          }

          resolve(responsePayload);
        },
        reject: (error) => {
          if (signal) {
            signal.removeEventListener("abort", handleAbort);
          }

          reject(error);
        },
      });

      this.#transport.send(message);
    });
  }
}

export namespace RPCConnection {
  export type Content<T extends RPCMessage.Transferable = RPCMessage.Transferable> = {
    data: RPCMessage.Streamable<T>;
    metadata: Record<string, string>;
  };

  export type HandlerContext = {
    id: string;
    method: string;
    signal: AbortSignal;
  };

  export type Handler = (content: Content, context: HandlerContext) => Promise<Content>;

  export type InvokeContext = {
    signal: AbortSignal;
  };

  export type Options = {
    handler?: Handler;
  };

  export type IncomingRequest = {
    message: RPCMessage.Request;
    controller: AbortController;
  };

  export type OutgoingRequest = {
    signal?: AbortSignal;
    message: RPCMessage.Request;
    resolve: (payload: Content) => void;
    reject: (error: Error) => void;
  };

  export interface Transport {
    send(message: RPCMessage): void;

    onMessage?: (message: RPCMessage) => void;
    onClose?: (error?: Error) => void;
  }
}
