import type { RPCDebugger } from "@/rpc-debugger";
import { RPCError } from "@/rpc-error";
import { RPCMessage } from "@/rpc-message";
import { RPCStreamsManager } from "@/rpc-streams-manager";

export class RPCConnection {
  #transport: RPCConnection.Transport;
  #streams: RPCStreamsManager;

  #handler?: RPCConnection.Handler;

  #debugger?: RPCDebugger;

  constructor(transport: RPCConnection.Transport, options: RPCConnection.Options) {
    if (transport.onMessage || transport.onDisconnect) {
      throw new Error(`Transport already has handlers`);
    }

    this.#transport = transport;
    this.#handler = options.handler;

    this.#transport.onDisconnect = this.#onClose.bind(this);
    this.#transport.onMessage = this.#onMessage.bind(this);

    this.#streams = new RPCStreamsManager(
      {
        send: (msg) => this.#transport.send(msg),
      },
      {
        debugger: options.debugger,
      },
    );

    this.#debugger = options.debugger;
  }

  #incomingRequests = new Map<string, RPCConnection.IncomingRequest>();
  #outgoingRequests = new Map<string, RPCConnection.OutgoingRequest>();

  #onMessage(message: RPCMessage) {
    this.#debugger?.debug("Received message", { type: message.type, id: "id" in message ? message.id : undefined });

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

    this.#debugger?.debug("Connection closing", {
      error: e.message,
      incomingRequests: this.#incomingRequests.size,
      outgoingRequests: this.#outgoingRequests.size,
    });

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
    this.#debugger?.debug("Received request", { id: message.id, method: message.method });

    const controller = new AbortController();

    const request: RPCConnection.IncomingRequest = {
      message,
      controller,
    };

    if (this.#incomingRequests.has(message.id)) {
      this.#debugger?.debug("Duplicate request received", { id: message.id });
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
        this.#debugger?.debug("Creating incoming stream for request", { id: message.id, streamId: message.content.stream });
        stream = this.#streams.createIncoming(message.content.stream, {
          signal: controller.signal,
        });
      } catch (error) {
        this.#debugger?.debug("Failed to create incoming stream for request", { id: message.id, error });
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

    this.#debugger?.debug("Processing request", { id: message.id, hasHandler: !!this.#handler });

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
            this.#debugger?.debug("Creating outgoing stream for response", { id: message.id });
            stream = this.#streams.createOutgoing(output.data, {
              signal: controller.signal,
            });
          } catch (error) {
            this.#debugger?.debug("Failed to create outgoing stream for response", { id: message.id, error });
            return this.#transport.send(
              RPCMessage.createFailureResponse(message.id, RPCError.fromUnknown(error, RPCError.Code.Internal).transferable()),
            );
          }

          this.#debugger?.debug("Sending success response with stream", { id: message.id, streamId: stream });
          return this.#transport.send(RPCMessage.createSuccessResponse(message.id, { stream }, output.metadata));
        } else {
          this.#debugger?.debug("Sending success response with data", { id: message.id });
          return this.#transport.send(RPCMessage.createSuccessResponse(message.id, { data: output.data }, output.metadata));
        }
      })
      .catch((error) => {
        this.#debugger?.debug("Request failed", { id: message.id, error });
        return this.#transport.send(
          RPCMessage.createFailureResponse(message.id, RPCError.fromUnknown(error, RPCError.Code.Internal).transferable()),
        );
      })
      .finally(() => {
        this.#debugger?.debug("Request completed", { id: message.id });
        this.#incomingRequests.delete(message.id);
      });
  }

  #onResponse(message: RPCMessage.Response) {
    this.#debugger?.debug("Received response", { requestId: message.request, hasError: "error" in message });

    const deferred = this.#outgoingRequests.get(message.request);

    if (!deferred) {
      this.#debugger?.debug("Response for unknown request", { requestId: message.request });
      return;
    }

    this.#outgoingRequests.delete(message.request);

    if ("error" in message) {
      this.#debugger?.debug("Response contains error", { requestId: message.request, error: message.error });
      return deferred.reject(RPCError.fromTransferable(message.error));
    }

    if ("stream" in message.content) {
      try {
        this.#debugger?.debug("Creating incoming stream from response", { requestId: message.request, streamId: message.content.stream });
        deferred.resolve({
          data: this.#streams.createIncoming(message.content.stream, {
            signal: deferred.signal,
          }),
          metadata: message.metadata,
        });
      } catch (err) {
        this.#debugger?.debug("Failed to create incoming stream from response", { requestId: message.request, error: err });
        deferred.reject(RPCError.fromUnknown(err, RPCError.Code.Internal));
      }
    } else {
      this.#debugger?.debug("Resolving response with data", { requestId: message.request });
      deferred.resolve({
        data: message.content.data,
        metadata: message.metadata,
      });
    }
  }

  #onEvent(message: RPCMessage.Event) {
    this.#debugger?.debug("Received event", { eventType: message.body.type, id: message.body.id });

    if (message.body.type === "request:canceled") {
      const request = this.#incomingRequests.get(message.body.id);

      if (!request) {
        this.#debugger?.debug("Cancel event for unknown request", { id: message.body.id });
        return;
      }

      this.#debugger?.debug("Canceling request by remote", { id: message.body.id });
      request.controller.abort(RPCError.createCanceled("Request canceled by remote side."));
    }

    this.#streams.handle(message);
  }

  async invoke(method: string, content: RPCConnection.Content, context?: RPCConnection.InvokeContext) {
    this.#debugger?.debug("Invoking method", { method });

    const signal = context?.signal;

    signal?.throwIfAborted();

    const message = RPCMessage.createRequest(method, { data: null }, content.metadata);

    if (content.data instanceof ReadableStream) {
      try {
        this.#debugger?.debug("Creating outgoing stream for invoke", { method, messageId: message.id });
        message.content = {
          stream: this.#streams.createOutgoing(content.data, {
            signal,
          }),
        };
      } catch (error) {
        this.#debugger?.debug("Failed to create outgoing stream for invoke", { method, messageId: message.id, error });
        throw RPCError.fromUnknown(error, RPCError.Code.Internal);
      }
    } else {
      message.content = { data: content.data };
    }

    this.#debugger?.debug("Sending request", { method, messageId: message.id });

    return new Promise((resolve, reject) => {
      const handleAbort = (reason: unknown) => {
        this.#debugger?.debug("Request aborted", { messageId: message.id, reason });
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
          this.#debugger?.debug("Request resolved", { messageId: message.id });
          if (signal) {
            signal.removeEventListener("abort", handleAbort);
          }

          resolve(responsePayload);
        },
        reject: (error) => {
          this.#debugger?.debug("Request rejected", { messageId: message.id, error });
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
    signal?: AbortSignal;
  };

  export type Options = {
    handler?: Handler;
    debugger?: RPCDebugger;
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
    onDisconnect?: (error?: Error) => void;
  }

  export type Encoder = {
    encode: (data: RPCMessage) => Uint8Array;
    decode: (data: Uint8Array) => RPCMessage;
  };
}
