import type { RPCMessage } from "@/rpc-message";

export type RPCMethod<I extends RPCMethod.Codec = RPCMethod.Codec, O extends RPCMethod.Codec = RPCMethod.Codec> = {
  type: RPCMethod.Type;
  incomingMessage: I;
  outgoingMessage: O;
};

export namespace RPCMethod {
  export type Promisable<T> = T | Promise<T>;
  export type PromisableStream<T> = Promisable<ReadableStream<T>>;

  export type Codec<O extends RPCMessage.Transferable = RPCMessage.Transferable, I extends RPCMessage.Transferable = O> = {
    encode(data: I): Promisable<Uint8Array>;
    decode(data: Uint8Array): Promisable<O>;
  };

  export namespace Codec {
    export type InferI<T> = T extends Codec<infer _, infer I> ? I : never;
    export type InferO<T> = T extends Codec<infer O, infer _> ? O : never;
  }

  export enum Type {
    Unary,
    ServerStream,
    ClientStream,
    BidiStream,
  }

  export type Handler<T extends RPCMethod = RPCMethod> =
    T extends RPCMethod<infer I, infer O>
      ? T["type"] extends Type.Unary
        ? Handler.Unary<I, O>
        : T["type"] extends Type.ServerStream
          ? Handler.ServerStream<I, O>
          : T["type"] extends Type.ClientStream
            ? Handler.ClientStream<I, O>
            : T["type"] extends Type.BidiStream
              ? Handler.BidiStream<I, O>
              : never
      : never;

  export namespace Handler {
    export type Context = {
      readonly id: string;
      readonly signal: AbortSignal;

      metadata: Record<string, string>;
    };

    type F<I, O> = (input: I, metadata: Record<string, string>, context: Context) => O;

    import InferI = Codec.InferI;
    import InferO = Codec.InferO;

    export type Unary<I extends Codec, O extends Codec> = F<InferO<I>, Promisable<InferI<O>>>;
    export type ServerStream<I extends Codec, O extends Codec> = F<InferO<I>, PromisableStream<InferI<O>>>;
    export type ClientStream<I extends Codec, O extends Codec> = F<ReadableStream<InferO<I>>, Promisable<InferI<O>>>;
    export type BidiStream<I extends Codec, O extends Codec> = F<ReadableStream<InferO<I>>, PromisableStream<InferI<O>>>;

    export type Any = F<RPCMessage.Streamable<RPCMessage.Transferable>, Promisable<RPCMessage.Streamable<RPCMessage.Transferable>>>;
  }

  export type Invoker<T extends RPCMethod> =
    T extends RPCMethod<infer I, infer O>
      ? T["type"] extends Type.Unary
        ? Invoker.Unary<I, O>
        : T["type"] extends Type.ServerStream
          ? Invoker.ServerStream<I, O>
          : T["type"] extends Type.ClientStream
            ? Invoker.ClientStream<I, O>
            : T["type"] extends Type.BidiStream
              ? Invoker.BidiStream<I, O>
              : never
      : never;

  export namespace Invoker {
    export type Options = {
      signal?: AbortSignal;
      metadata?: Record<string, string>;
    };

    type F<I, O> = (input: I, options: Options) => O;

    import InferI = Codec.InferI;
    import InferO = Codec.InferO;

    export type Unary<I extends Codec, O extends Codec> = F<InferI<I>, Promise<InferO<O>>>;
    export type ServerStream<I extends Codec, O extends Codec> = F<InferI<I>, Promise<ReadableStream<InferO<O>>>>;
    export type ClientStream<I extends Codec, O extends Codec> = F<ReadableStream<InferI<I>>, Promise<InferO<O>>>;
    export type BidiStream<I extends Codec, O extends Codec> = F<ReadableStream<InferI<I>>, Promise<ReadableStream<InferO<O>>>>;
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
}
