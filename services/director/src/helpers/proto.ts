import {
  type DescEnum,
  type DescMessage,
  type DescService,
  fromBinary,
  fromJson,
  type JsonValue,
  type Message as RuntimeShape,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";

export namespace Proto {
  export class Message<T extends Record<string, unknown> = Record<string, unknown>> {
    #schema: DescMessage;
    #converters: Message.Converters<T>;

    constructor(schema: DescMessage, converters: Message.Converters<T>) {
      this.#schema = schema;
      this.#converters = converters;
    }

    get schema() {
      return this.#schema;
    }

    get name() {
      return this.#schema.typeName;
    }

    toJson(message: T) {
      return toJson(this.#schema, this.toRuntimeShape(message));
    }

    toBinary(message: T) {
      return toBinary(this.#schema, this.toRuntimeShape(message));
    }

    toRuntimeShape(message: T) {
      return this.#converters.toRuntimeShape(message);
    }

    fromJson(json: JsonValue) {
      return this.fromRuntimeShape(fromJson(this.#schema, json));
    }

    fromBinary(binary: Uint8Array) {
      return this.fromRuntimeShape(fromBinary(this.#schema, binary));
    }

    fromRuntimeShape(shape: RuntimeShape) {
      const res = Message.#validator.validate(this.#schema, shape);

      if (res.kind !== "valid") {
        throw res.error;
      }

      return this.#converters.fromRuntimeShape(shape);
    }

    validate(value: T) {
      const res = Message.#validator.validate(this.#schema, this.toRuntimeShape(value));

      if (res.kind !== "valid") {
        throw res.error;
      }

      return this.fromRuntimeShape(res.message);
    }

    static #validator = createValidator({ legacyRequired: true, failFast: true });
  }

  export namespace Message {
    export type Type<T> = T extends Message<infer V> ? V : never;

    export type Converters<T> = {
      toRuntimeShape(message: T): RuntimeShape;
      fromRuntimeShape(shape: RuntimeShape): T;
    };
  }

  export class Service<T extends Record<string, Method> = Record<string, Method>> {
    #schema: DescService;
    #methods: Readonly<T>;

    constructor(methods: T, schema: DescService) {
      this.#schema = schema;
      this.#methods = Object.freeze(methods);
    }

    get schema() {
      return this.#schema;
    }

    get methods() {
      return this.#methods;
    }

    get name() {
      return this.#schema.typeName;
    }
  }

  export namespace Service {
    // biome-ignore format: x
    export type UnaryImplementation<T1 extends Proto.Message = Proto.Message, T2 extends Proto.Message= Proto.Message, T3 = unknown> = (request: Message.Type<T1>, context: T3) => Promise<Message.Type<T2>>;
    // biome-ignore format: x
    export type ClientStreamingImplementation<T1 extends Proto.Message = Proto.Message, T2 extends Proto.Message = Proto.Message, T3 = unknown> = (request: AsyncIterable<Message.Type<T1>>, context: T3) => Promise<Message.Type<T2>>;
    // biome-ignore format: x
    export type ServerStreamingImplementation<T1 extends Proto.Message = Proto.Message, T2 extends Proto.Message = Proto.Message, T3 = unknown> = (request: Message.Type<T1>, context: T3) => AsyncIterable<Message.Type<T2>>;
    // biome-ignore format: x
    export type BidiStreamingImplementation<T1 extends Proto.Message = Proto.Message, T2 extends Proto.Message = Proto.Message, T3 = unknown> = (request: AsyncIterable<Message.Type<T1>>, context: T3) => AsyncIterable<Message.Type<T2>>;

    export type Implementation<T1 extends Proto.Service, T2 = unknown> = {
      [K in keyof T1["methods"]]: Implementation.Method<T1["methods"][K], T2>;
    };

    export namespace Implementation {
      export type Method<T1 extends Proto.Method, T2 = unknown> = T1["kind"] extends "unary"
        ? UnaryImplementation<T1["request"], T1["response"], T2>
        : T1["kind"] extends "client-streaming"
          ? ClientStreamingImplementation<T1["request"], T1["response"], T2>
          : T1["kind"] extends "server-streaming"
            ? ServerStreamingImplementation<T1["request"], T1["response"], T2>
            : T1["kind"] extends "bidi-streaming"
              ? BidiStreamingImplementation<T1["request"], T1["response"], T2>
              : never;
    }
  }

  export class Enum<T extends number> {
    #schema: DescEnum;

    constructor(schema: DescEnum) {
      this.#schema = schema;
    }

    get schema() {
      return this.#schema;
    }

    get name() {
      return this.#schema.typeName;
    }
  }

  export namespace Enum {
    export type Type<T> = T extends Enum<infer V> ? V : never;
  }

  export class Method<K extends Method.Kind = Method.Kind, R extends Message = Message, T extends Message = Message> {
    #kind: K;
    #request: R;
    #response: T;

    constructor(kind: K, request: R, response: T) {
      this.#kind = kind;
      this.#request = request;
      this.#response = response;
    }

    get kind() {
      return this.#kind;
    }

    get request() {
      return this.#request;
    }

    get response() {
      return this.#response;
    }

    get isUnary() {
      return this.#kind === "unary";
    }

    get isClientStreaming() {
      return this.#kind === "client-streaming";
    }

    get isServerStreaming() {
      return this.#kind === "server-streaming";
    }

    get isBidiStreaming() {
      return this.#kind === "bidi-streaming";
    }
  }

  export namespace Method {
    export type Kind = "unary" | "client-streaming" | "server-streaming" | "bidi-streaming";

    export type RequestType<T> = T extends Method<Method.Kind, infer V, infer _> ? Message.Type<V> : never;
    export type ResponseType<T> = T extends Method<Method.Kind, infer _, infer V> ? Message.Type<V> : never;
  }

  export const createMessage = <T extends Record<string, unknown> = Record<string, unknown>>(
    desc: DescMessage,
    converters: Message.Converters<T>,
  ) => {
    return new Message<T>(desc, converters);
  };

  export const createService = <T extends Record<string, Method> = Record<string, Method>, S extends DescService = DescService>(
    methods: T,
    desc: S,
  ) => {
    return new Service<T>(methods, desc);
  };

  export const createEnum = <T extends number, V extends Record<string, T> = Record<string, T>>(desc: DescEnum, values: V) => {
    const instance = new Enum(desc) as Enum<T> & Readonly<V>;

    for (const [k, v] of Object.entries(values)) {
      if (Object.hasOwn(values, k)) {
        Object.defineProperty(instance, k, {
          get() {
            return v;
          },
        });
      }
    }

    return instance;
  };

  export const createUnaryMethod = <R extends Message = Message, T extends Message = Message>(request: R, response: T) => {
    return new Method("unary", request, response);
  };

  export const createClientStreamingMethod = <R extends Message = Message, T extends Message = Message>(request: R, response: T) => {
    return new Method("client-streaming", request, response);
  };

  export const createServerStreamingMethod = <R extends Message = Message, T extends Message = Message>(request: R, response: T) => {
    return new Method("server-streaming", request, response);
  };

  export const createBidiStreamingMethod = <R extends Message = Message, T extends Message = Message>(request: R, response: T) => {
    return new Method("bidi-streaming", request, response);
  };
}
