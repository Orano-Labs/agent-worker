import {
  createMutableRegistry,
  DescEnum,
  DescMessage,
  DescMethod,
  DescService,
  fromBinary,
  fromJson,
  Message as RuntimeShape,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import { CompilationError, createValidator, ValidationError as InternalValidationError, RuntimeError } from "@bufbuild/protovalidate";

export namespace Proto {
  export const registry = createMutableRegistry();

  export class Message<T extends Message.Unknown = Message.Unknown> {
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
      return toJson(this.#schema, this.toRuntimeShape(message)) as JSONObject;
    }

    toBinary(message: T) {
      return toBinary(this.#schema, this.toRuntimeShape(message));
    }

    toRuntimeShape(message: T) {
      return this.#converters.toRuntimeShape(message);
    }

    toAny(message: T) {
      return {
        typeUrl: this.#schema.typeName,
        value: this.toBinary(message),
      } satisfies Message.Any as Message.Any;
    }

    fromJson(json: JSONValue) {
      return this.fromRuntimeShape(fromJson(this.#schema, json));
    }

    fromBinary(binary: Uint8Array) {
      return this.fromRuntimeShape(fromBinary(this.#schema, binary));
    }

    fromRuntimeShape(shape: RuntimeShape) {
      const res = Message.#validator.validate(this.#schema, shape);

      if (res.kind !== "valid") {
        throw new Message.ValidationError(
          res.error instanceof InternalValidationError
            ? {
                type: "validation",
                source: res.error,
              }
            : res.error instanceof RuntimeError
              ? {
                  type: "runtime",
                  source: res.error,
                }
              : {
                  type: "compilation",
                  source: res.error,
                },
        );
      }

      return this.#converters.fromRuntimeShape(shape);
    }

    fromRuntimeShapeUnsafe(shape: RuntimeShape) {
      return this.#converters.fromRuntimeShape(shape);
    }

    fromAny(any: Message.Any) {
      if (any.typeUrl === this.#schema.typeName) {
        return this.fromBinary(any.value);
      }

      return null;
    }

    fromAnyMust(any: Message.Any) {
      if (any.typeUrl !== this.#schema.typeName) {
        throw new Error("xxx");
      }

      return this.fromBinary(any.value);
    }

    validate(value: T) {
      const res = Message.#validator.validate(this.#schema, this.toRuntimeShape(value));

      if (res.kind === "valid") {
        return {
          valid: true,
          message: this.fromRuntimeShape(res.message),
        } satisfies Message.ValidationResult<T> as Message.ValidationResult<T>;
      }

      return {
        valid: false,
        reason:
          res.error instanceof InternalValidationError
            ? {
                type: "validation",
                source: res.error,
              }
            : res.error instanceof RuntimeError
              ? {
                  type: "runtime",
                  source: res.error,
                }
              : {
                  type: "compilation",
                  source: res.error,
                },
      } satisfies Message.ValidationResult<T> as Message.ValidationResult<T>;
    }

    validateUnsafe(value: T) {
      const result = this.validate(value);

      if (result.valid) {
        return result.message;
      }

      throw new Message.ValidationError(result.reason);
    }

    static #validator = createValidator({ legacyRequired: true, failFast: true, registry });
  }

  export namespace Message {
    export type Type<T> = T extends Message<infer V> ? V : never;

    export type Converters<T> = {
      toRuntimeShape(message: T): RuntimeShape;
      fromRuntimeShape(shape: RuntimeShape): T;
    };

    export type Any = {
      typeUrl: string;
      value: Uint8Array;
    };

    export type Unknown = Record<string, unknown>;

    export type ValidationResult<T> =
      | {
          valid: true;
          message: T;
        }
      | {
          valid: false;
          reason: ValidationError.Reason;
        };

    export class ValidationError extends Error {
      #reason: ValidationError.Reason;

      constructor(reason: ValidationError.Reason) {
        super(reason.source.message, {
          cause: reason.source,
        });

        this.#reason = reason;
      }

      get reason() {
        return this.#reason;
      }
    }

    export namespace ValidationError {
      export type Reason =
        | {
            type: "validation";
            source: InternalValidationError;
          }
        | {
            type: "runtime";
            source: RuntimeError;
          }
        | {
            type: "compilation";
            source: CompilationError;
          };
    }
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
      // biome-ignore format: x
      export type Method<T1 extends Proto.Method = Proto.Method, T2 = unknown> = {
        "unary": UnaryImplementation<T1["request"], T1["response"], T2>;
        "client-streaming": ClientStreamingImplementation<T1["request"], T1["response"], T2>;
        "server-streaming": ServerStreamingImplementation<T1["request"], T1["response"], T2>;
        "bidi-streaming": BidiStreamingImplementation<T1["request"], T1["response"], T2>;
      }[T1["kind"]];
    }
  }

  export class Enum<T extends number> {
    #schema: DescEnum;
    #values: ReadonlyArray<T>;

    constructor(schema: DescEnum, values: T[]) {
      this.#schema = schema;
      this.#values = Object.freeze(values);
    }

    get schema() {
      return this.#schema;
    }

    get name() {
      return this.#schema.typeName;
    }

    get values() {
      return this.#values;
    }

    is(value: number): value is T {
      return this.#values.includes(value as T);
    }
  }

  export namespace Enum {
    export type Type<T> = T extends Enum<infer V> ? V : never;
  }

  export class Method<K extends Method.Kind = Method.Kind, T1 extends Message = Message, T2 extends Message = Message> {
    #kind: K;
    #name: string;
    #schema: DescMethod;
    #request: T1;
    #response: T2;

    constructor(kind: K, name: string, schema: DescMethod, request: T1, response: T2) {
      this.#kind = kind;
      this.#name = name;
      this.#schema = schema;
      this.#request = request;
      this.#response = response;
    }

    get kind() {
      return this.#kind;
    }

    get name() {
      return this.#name;
    }

    get schema() {
      return this.#schema;
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
    const instance = new Enum(desc, Object.values(values)) as Enum<T> & Readonly<V>;

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

  export const createUnaryMethod = <R extends Message = Message, T extends Message = Message>(
    name: string,
    schema: DescMethod,
    request: R,
    response: T,
  ) => {
    return new Method("unary", name, schema, request, response);
  };

  export const createClientStreamingMethod = <R extends Message = Message, T extends Message = Message>(
    name: string,
    schema: DescMethod,
    request: R,
    response: T,
  ) => {
    return new Method("client-streaming", name, schema, request, response);
  };

  export const createServerStreamingMethod = <R extends Message = Message, T extends Message = Message>(
    name: string,
    schema: DescMethod,
    request: R,
    response: T,
  ) => {
    return new Method("server-streaming", name, schema, request, response);
  };

  export const createBidiStreamingMethod = <R extends Message = Message, T extends Message = Message>(
    name: string,
    schema: DescMethod,
    request: R,
    response: T,
  ) => {
    return new Method("bidi-streaming", name, schema, request, response);
  };

  export type JSONValue = number | string | boolean | null | JSONObject | JSONValue[];
  export type JSONObject = {
    [k: string]: JSONValue;
  };
}
