import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { RPCMessage } from "@/rpc-message";

export type RPCMethod<I extends RPCMethod.Schema = RPCMethod.Schema, O extends RPCMethod.Schema = RPCMethod.Schema> = {
  type: RPCMethod.Type;
  incomingMessage: I;
  outgoingMessage: O;
};

export namespace RPCMethod {
  export type Promisable<T> = T | Promise<T>;
  export type PromisableStream<T> = Promisable<ReadableStream<T>>;

  export type Schema<O extends RPCMessage.Transferable = RPCMessage.Transferable, I extends RPCMessage.Transferable = O> = StandardSchemaV1<
    I,
    O
  >;

  export namespace Schema {
    export type InferI<T> = T extends Schema<infer _, infer I> ? I : never;
    export type InferO<T> = T extends Schema<infer O, infer _> ? O : never;
  }

  export type Type = "unary" | "server-stream" | "client-stream" | "bidirectional-stream";

  export type Handler<T extends RPCMethod = RPCMethod> =
    T extends RPCMethod<infer I, infer O>
      ? T["type"] extends "unary"
        ? Handler.Unary<I, O>
        : T["type"] extends "server-stream"
          ? Handler.ServerStream<I, O>
          : T["type"] extends "client-stream"
            ? Handler.ClientStream<I, O>
            : T["type"] extends "bidirectional-stream"
              ? Handler.BidirectionalStream<I, O>
              : never
      : never;

  export namespace Handler {
    export type Context = {
      readonly id: string;
      readonly signal: AbortSignal;

      metadata: Record<string, string>;
    };

    import InferI = Schema.InferI;
    import InferO = Schema.InferO;

    type F<I, O> = (input: I, metadata: Record<string, string>, context: Context) => O;

    export type Unary<I extends Schema, O extends Schema> = F<InferO<I>, Promisable<InferI<O>>>;
    export type ServerStream<I extends Schema, O extends Schema> = F<InferO<I>, PromisableStream<InferI<O>>>;
    export type ClientStream<I extends Schema, O extends Schema> = F<ReadableStream<InferO<I>>, Promisable<InferI<O>>>;
    export type BidirectionalStream<I extends Schema, O extends Schema> = F<ReadableStream<InferO<I>>, PromisableStream<InferI<O>>>;

    export type Any = F<RPCMessage.Streamable<RPCMessage.Transferable>, Promisable<RPCMessage.Streamable<RPCMessage.Transferable>>>;
  }

  export type Invoker<T extends RPCMethod> =
    T extends RPCMethod<infer I, infer O>
      ? T["type"] extends "unary"
        ? Invoker.Unary<I, O>
        : T["type"] extends "server-stream"
          ? Invoker.ServerStream<I, O>
          : T["type"] extends "client-stream"
            ? Invoker.ClientStream<I, O>
            : T["type"] extends "bidirectional-stream"
              ? Invoker.BidirectionalStream<I, O>
              : never
      : never;

  export namespace Invoker {
    export type Options = {
      signal?: AbortSignal;
      metadata?: Record<string, string>;
    };

    type F<I, O> = (input: I, options?: Options) => O;

    import InferI = Schema.InferI;
    import InferO = Schema.InferO;

    export type Unary<I extends Schema, O extends Schema> = F<InferI<I>, Promise<InferO<O>>>;
    export type ServerStream<I extends Schema, O extends Schema> = F<InferI<I>, Promise<ReadableStream<InferO<O>>>>;
    export type ClientStream<I extends Schema, O extends Schema> = F<ReadableStream<InferI<I>>, Promise<InferO<O>>>;
    export type BidirectionalStream<I extends Schema, O extends Schema> = F<ReadableStream<InferI<I>>, Promise<ReadableStream<InferO<O>>>>;
  }

  export type Collection = {
    [name: string]: RPCMethod;
  };

  export namespace Collection {
    export type HandlersImplementation<T extends Collection> = {
      [K in keyof T]: Handler<T[K]>;
    };

    export type InvokersImplementation<T extends Collection> = {
      [K in keyof T]: Invoker<T[K]>;
    };
  }

  export const defineUnary = <I extends Schema, O extends Schema>(incomingMessage: I, outgoingMessage: O) => {
    return {
      type: "unary",
      incomingMessage,
      outgoingMessage,
    } satisfies RPCMethod<I, O>;
  };

  export const defineServerStream = <I extends Schema, O extends Schema>(incomingMessage: I, outgoingMessage: O) => {
    return {
      type: "server-stream",
      incomingMessage,
      outgoingMessage,
    } satisfies RPCMethod<I, O>;
  };

  export const defineClientStream = <I extends Schema, O extends Schema>(incomingMessage: I, outgoingMessage: O) => {
    return {
      type: "client-stream",
      incomingMessage,
      outgoingMessage,
    } satisfies RPCMethod<I, O>;
  };

  export const defineBidirectionalStream = <I extends Schema, O extends Schema>(incomingMessage: I, outgoingMessage: O) => {
    return {
      type: "bidirectional-stream",
      incomingMessage,
      outgoingMessage,
    } satisfies RPCMethod<I, O>;
  };
}
