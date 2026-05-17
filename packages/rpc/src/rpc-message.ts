export type RPCMessage = RPCMessage.Request | RPCMessage.Response | RPCMessage.Event;

export namespace RPCMessage {
  export type Transferable =
    | string
    | number
    | bigint
    | boolean
    | undefined
    | null
    | Uint8Array
    | Date
    | {
        [key: string]: Transferable;
      }
    | Transferable[];

  export type Streamable<T> = T | ReadableStream<T>;

  export type Content =
    | {
        stream: string;
      }
    | {
        data: Transferable;
      };

  export type Error = {
    code: number;
    message: string;
    details?: Record<string, Transferable>;
  };

  export type Request = {
    type: "request";
    content: Content;
    id: string;
    method: string;
    metadata: Record<string, string>;
  };

  export type SuccessResponse = {
    type: "response";
    content: Content;
    request: string;
    metadata: Record<string, string>;
  };

  export type FailureResponse = {
    type: "response";
    error: Error;
    request: string;
    metadata: Record<string, string>;
  };

  export type Response = SuccessResponse | FailureResponse;

  export type EventBody =
    | {
        type: "stream:frame";
        id: string;
        data: unknown;
      }
    | {
        type: "stream:closed";
        id: string;
      }
    | {
        type: "stream:error";
        id: string;
        error: Error;
      }
    | {
        type: "stream:canceled";
        id: string;
      }
    | {
        type: "request:canceled";
        id: string;
      };

  export type Event = {
    type: "event";
    body: EventBody;
  };

  export const createRequest = (method: string, content: RPCMessage.Content, metadata?: Record<string, string>) => {
    return {
      type: "request",
      method,
      content,
      id: crypto.randomUUID(),
      metadata: metadata || {},
    } satisfies Request;
  };

  export const createSuccessResponse = (id: string, content: RPCMessage.Content, metadata?: Record<string, string>) => {
    return {
      type: "response",
      request: id,
      content,
      metadata: metadata || {},
    } satisfies SuccessResponse;
  };

  export const createFailureResponse = (id: string, error: RPCMessage.Error, metadata?: Record<string, string>) => {
    return {
      type: "response",
      request: id,
      error,
      metadata: metadata || {},
    } satisfies FailureResponse;
  };

  export const createEvent = (body: EventBody) => {
    return { type: "event", body: body } satisfies Event;
  };

  export const createStreamFrameEvent = (id: string, data: unknown) => {
    return RPCMessage.createEvent({ type: "stream:frame", id, data });
  };

  export const createStreamClosedEvent = (id: string) => {
    return RPCMessage.createEvent({ type: "stream:closed", id });
  };

  export const createStreamErrorEvent = (id: string, error: RPCMessage.Error) => {
    return RPCMessage.createEvent({ type: "stream:error", id, error });
  };

  export const createStreamCanceledEvent = (id: string) => {
    return RPCMessage.createEvent({ type: "stream:canceled", id });
  };

  export const createRequestCanceledEvent = (id: string) => {
    return RPCMessage.createEvent({ type: "request:canceled", id });
  };
}
