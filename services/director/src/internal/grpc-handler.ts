import { Container } from "@aw/container";
import { Logger } from "@aw/logging";
import { Proto } from "@aw/proto";
import {
  DescMessage,
  DescMethodBiDiStreaming,
  DescMethodClientStreaming,
  DescMethodServerStreaming,
  DescMethodUnary,
  Message,
} from "@bufbuild/protobuf";
import { createValidator, violationsToProto } from "@bufbuild/protovalidate";
import { ConnectError, ContextKey, createContextKey, createContextValues, HandlerContext, Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { getClientIp } from "@supercharge/request-ip";
import { Any } from "@/generated/proto/google/protobuf/any";
import { HTTPServer } from "@/internal/http-server";

export class GRPCHandler extends Container.ServiceConstructable {
  #server: HTTPServer;
  #logger: Logger;
  #services: GRPCHandler.Service[];

  #connectContextKey: ContextKey<GRPCHandler.Context.Value[]>;
  #controller: AbortController;

  constructor(...deps: [HTTPServer, Logger, GRPCHandler.Service[]]) {
    super();

    this.#server = deps[0];
    this.#logger = deps[1].namespace("GRPCHandler");
    this.#services = deps[2];
    this.#controller = new AbortController();

    this.#connectContextKey = createContextKey([]);
  }

  #applyInterceptors(route: GRPCHandler.Route, handler: GRPCHandler.Handler) {
    return [...route.interceptors].toReversed().reduce((next, interceptor) => interceptor(next), handler);
  }

  #createContext(route: GRPCHandler.Route, context: HandlerContext) {
    const result = new GRPCHandler.Context({
      url: context.url,
      signal: context.signal,
      incomingHeaders: context.requestHeader,
      outgoingHeaders: context.responseHeader,
      outgoingTrailers: context.responseTrailer,
      handler: route,
      deadline: context.timeoutMs,
    });

    for (const { key, value } of context.values.get(this.#connectContextKey)) {
      result.set(key, value);
    }

    return result;
  }

  #createUnaryHandler(route: GRPCHandler.Route<Proto.Method<"unary">>) {
    const handler = async (
      request: Extract<GRPCHandler.Request, { stream: false }>,
    ): Promise<Extract<GRPCHandler.Response, { stream: false }>> => {
      return {
        stream: false,
        method: route.method,
        message: await route.implementation(request.message, request.context),
      };
    };

    return this.#applyInterceptors(route, handler as GRPCHandler.Handler) as typeof handler;
  }

  #createClientStreamHandler(route: GRPCHandler.Route<Proto.Method<"client-streaming">>) {
    const handler = async (
      request: Extract<GRPCHandler.Request, { stream: true }>,
    ): Promise<Extract<GRPCHandler.Response, { stream: false }>> => {
      return {
        stream: false,
        method: route.method,
        message: await route.implementation(request.message, request.context),
      };
    };

    return this.#applyInterceptors(route, handler as GRPCHandler.Handler) as typeof handler;
  }

  #createServerStreamHandler(route: GRPCHandler.Route<Proto.Method<"server-streaming">>) {
    const handler = async (
      request: Extract<GRPCHandler.Request, { stream: false }>,
    ): Promise<Extract<GRPCHandler.Response, { stream: true }>> => {
      return {
        stream: true,
        method: route.method,
        message: route.implementation(request.message, request.context),
      };
    };

    return this.#applyInterceptors(route, handler as GRPCHandler.Handler) as typeof handler;
  }

  #createBidiStreamHandler(route: GRPCHandler.Route<Proto.Method<"bidi-streaming">>) {
    const handler = async (
      request: Extract<GRPCHandler.Request, { stream: true }>,
    ): Promise<Extract<GRPCHandler.Response, { stream: true }>> => {
      return {
        stream: true,
        method: route.method,
        message: route.implementation(request.message, request.context),
      };
    };

    return this.#applyInterceptors(route, handler as GRPCHandler.Handler) as typeof handler;
  }

  #createUnaryAdapter(route: GRPCHandler.Route<Proto.Method<"unary">>) {
    const handler = this.#createUnaryHandler(route);

    return async (request: Message, context: HandlerContext) => {
      return handler({
        stream: false,
        message: route.method.request.fromRuntimeShapeUnsafe(request),
        method: route.method,
        context: this.#createContext(route, context),
      }).then((response) => {
        return route.method.response.toRuntimeShape(response.message);
      });
    };
  }

  #createClientStreamAdapter(route: GRPCHandler.Route<Proto.Method<"client-streaming">>) {
    const handler = this.#createClientStreamHandler(route);

    return async (request: AsyncIterable<Message>, context: HandlerContext) => {
      return handler({
        stream: true,
        message: (async function* () {
          for await (const chunk of request) {
            yield route.method.request.fromRuntimeShapeUnsafe(chunk);
          }
        })(),
        method: route.method,
        context: this.#createContext(route, context),
      }).then((response) => {
        return route.method.response.toRuntimeShape(response.message);
      });
    };
  }

  #createServerStreamAdapter(route: GRPCHandler.Route<Proto.Method<"server-streaming">>) {
    const handler = this.#createServerStreamHandler(route);
    const self = this;

    return async function* (request: Message, context: HandlerContext) {
      const response = await handler({
        stream: false,
        message: route.method.request.fromRuntimeShapeUnsafe(request),
        method: route.method,
        context: self.#createContext(route, context),
      });

      for await (const chunk of response.message) {
        yield route.method.response.toRuntimeShape(chunk);
      }
    };
  }

  #createBidiStreamAdapter(route: GRPCHandler.Route<Proto.Method<"bidi-streaming">>) {
    const handler = this.#createBidiStreamHandler(route);
    const self = this;

    return async function* (request: AsyncIterable<Message>, context: HandlerContext) {
      const response = await handler({
        stream: true,
        message: (async function* () {
          for await (const chunk of request) {
            yield route.method.request.fromRuntimeShapeUnsafe(chunk);
          }
        })(),
        method: route.method,
        context: self.#createContext(route, context),
      });

      for await (const chunk of response.message) {
        yield route.method.response.toRuntimeShape(chunk);
      }
    };
  }

  #createConnectLoggingInterceptor() {
    const slowRequestThreshold = 1_000;
    const interceptor: Interceptor = (next) => {
      return async (request) => {
        const now = performance.now();
        const ip = request.contextValues.get(this.#connectContextKey).find((value) => value.key === GRPCHandler.Context.ip)?.value;

        const print = (status: { type: "completed" | "returned" } | { type: "failed"; error: unknown }) => {
          const duration = performance.now() - now;
          const method = request.method.name;
          const http = {
            method: request.requestMethod.toLowerCase(),
            url: request.url,
          };

          if (status.type === "failed") {
            this.#logger.error(`Method ${method} failed after ${duration.toFixed(2)}ms`, {
              err: status.error,
              ip,
              http,
            });
          } else if (duration >= slowRequestThreshold) {
            this.#logger.warn(`Method ${method} completed slowly in ${duration.toFixed(2)}ms (threshold: ${slowRequestThreshold}ms)`, {
              ip,
              http,
            });
          } else {
            this.#logger.info(`Method ${method} completed successfully in ${duration.toFixed(2)}ms`, {
              ip,
              http,
            });
          }
        };

        try {
          const response = await next(request);

          if (!response.stream) {
            print({
              type: "completed",
            });

            return response;
          }

          const message = (async function* () {
            let status: { type: "completed" } | { type: "failed"; error: unknown } | undefined;

            try {
              yield* response.message;

              status = {
                type: "completed",
              };
            } catch (error) {
              status = {
                type: "failed",
                error,
              };

              throw error;
            } finally {
              if (!status) {
                print({ type: "returned" });
              } else if (status.type === "completed") {
                print({ type: "completed" });
              } else {
                print({ type: "failed", error: status.error });
              }
            }
          })();

          return { ...response, message };
        } catch (error) {
          print({
            type: "failed",
            error,
          });

          throw error;
        }
      };
    };

    return interceptor;
  }

  #createConnectErrorTransformationInterceptor() {
    const transfromError = (error: unknown) => {
      if (error instanceof ConnectError) {
        throw error;
      }

      const internal = GRPCHandler.Error.fromUnknown(error, GRPCHandler.Error.Code.Internal);
      const final = new ConnectError(internal.message, internal.code, internal.metadata, undefined, error);

      for (const detail of internal.details) {
        final.details.push({
          type: detail.typeUrl,
          value: detail.value,
        });
      }

      return final;
    };

    const interceptor: Interceptor = (next) => {
      return async (request) => {
        try {
          const response = await next(request);

          if (!response.stream) {
            return response;
          }

          const message = (async function* () {
            try {
              yield* response.message;
            } catch (error) {
              throw transfromError(error);
            }
          })();

          return { ...response, message };
        } catch (error) {
          throw transfromError(error);
        }
      };
    };

    return interceptor;
  }

  #createConnectRequestValidationInterceptor() {
    const validator = createValidator({ registry: Proto.registry, failFast: true });

    const validate = (desc: DescMessage, message: Message) => {
      const result = validator.validate(desc, message);

      if (result.kind === "valid") {
        return result.message;
      }

      const details = [];

      if (result.violations) {
        const [value, desc] = violationsToProto(result.violations);

        details.push({
          desc,
          value,
        });
      }

      throw new ConnectError(result.error.message, 3, undefined, details, result.error);
    };

    const interceptor: Interceptor = (next) => {
      return async (request) => {
        if (!request.stream) {
          return next({ ...request, message: validate(request.method.input, request.message) });
        }

        const message = (async function* () {
          for await (const item of request.message) {
            yield validate(request.method.input, item);
          }
        })();

        return next({ ...request, message });
      };
    };

    return interceptor;
  }

  override async initialize(_signal: AbortSignal) {
    let routeCount = 0;

    const adapter = connectNodeAdapter({
      grpc: false,
      grpcWeb: true,
      connect: false,
      requestPathPrefix: "/grpc",
      routes: (router) => {
        for (const service of this.#services) {
          service.setup((route) => {
            routeCount += 1;
            const schema = route.method.schema as
              | DescMethodBiDiStreaming
              | DescMethodClientStreaming
              | DescMethodServerStreaming
              | DescMethodUnary;

            if (schema.methodKind === "unary") {
              router.rpc(schema, this.#createUnaryAdapter(route as GRPCHandler.Route<Proto.Method<"unary">>));
            }

            if (schema.methodKind === "client_streaming") {
              router.rpc(schema, this.#createClientStreamAdapter(route as GRPCHandler.Route<Proto.Method<"client-streaming">>));
            }

            if (schema.methodKind === "server_streaming") {
              router.rpc(schema, this.#createServerStreamAdapter(route as GRPCHandler.Route<Proto.Method<"server-streaming">>));
            }

            if (schema.methodKind === "bidi_streaming") {
              router.rpc(schema, this.#createBidiStreamAdapter(route as GRPCHandler.Route<Proto.Method<"bidi-streaming">>));
            }
          });
        }
      },
      shutdownSignal: this.#controller.signal,
      interceptors: [
        //
        this.#createConnectLoggingInterceptor(),
        this.#createConnectErrorTransformationInterceptor(),
        this.#createConnectRequestValidationInterceptor(),
      ],
      contextValues: (request) => {
        return createContextValues().set(this.#connectContextKey, [
          GRPCHandler.Context.value(GRPCHandler.Context.ip, getClientIp(request)),
        ]);
      },
    });

    this.#server.router.request("*", "/grpc", ({ req, res }) => {
      adapter(req, res);
    });

    this.#logger.info("Registered endpoint routes", {
      path: "/grpc-web",
      services: this.#services.length,
      routes: routeCount,
    });
  }

  override async dispose(reason: unknown) {
    this.#controller.abort(reason);
  }

  static route<T extends Proto.Method = Proto.Method>(
    method: T,
    implementation: Proto.Service.Implementation.Method<T, GRPCHandler.Context>,
  ) {
    return new GRPCHandler.Route(method, implementation);
  }
}

export namespace GRPCHandler {
  export class Context {
    #url: string;
    #signal: AbortSignal;

    #incomingHeaders: Headers;
    #outgoingHeaders: Headers;
    #outgoingTrailers: Headers;

    #handler: Route;
    #deadline: () => number | undefined;

    #values: Map<symbol, unknown>;

    constructor(options: Context.Options) {
      this.#url = options.url;
      this.#signal = options.signal;
      this.#incomingHeaders = options.incomingHeaders;
      this.#outgoingHeaders = options.outgoingHeaders;
      this.#outgoingTrailers = options.outgoingTrailers;
      this.#handler = options.handler;

      this.#deadline = options.deadline;

      this.#values = new Map();
    }

    get url() {
      return this.#url;
    }

    get signal() {
      return this.#signal;
    }

    get incomingHeaders() {
      return this.#incomingHeaders;
    }

    get outgoingHeaders() {
      return this.#outgoingHeaders;
    }

    get outgoingTrailers() {
      return this.#outgoingTrailers;
    }

    get handler() {
      return this.#handler;
    }

    get ip() {
      return this.get(Context.ip);
    }

    get deadline() {
      return this.#deadline;
    }

    get<T>(key: Context.Key<T>) {
      return this.#values.get(key) as T | undefined;
    }

    set<T>(key: Context.Key<T>, value: T) {
      this.#values.set(key, value);
    }

    has(key: Context.Key) {
      return this.#values.has(key);
    }

    static key<T>(description?: string) {
      return Symbol(description) as Context.Key<T>;
    }

    static value<T>(key: Context.Key<T>, value: T) {
      return { key, value } as Context.Value<T>;
    }

    static readonly ip: Context.Key<string> = Symbol();
  }

  export namespace Context {
    export type Options = {
      url: string;
      signal: AbortSignal;
      incomingHeaders: Headers;
      outgoingHeaders: Headers;
      outgoingTrailers: Headers;
      handler: Route;
      deadline: () => number | undefined;
    };

    export type Key<T = unknown> = symbol & { __T__?: T };

    export type Value<T = unknown> = {
      readonly key: Key<T>;
      readonly value: T;
    };
  }

  export class Route<T extends Proto.Method = Proto.Method> {
    #method: T;
    #implementation: Proto.Service.Implementation.Method<T, Context>;
    #interceptors: Interceptor[];

    constructor(method: T, implementation: Proto.Service.Implementation.Method<T, Context>) {
      this.#method = method;
      this.#implementation = implementation;
      this.#interceptors = [];
    }

    get method() {
      return this.#method;
    }

    get implementation() {
      return this.#implementation;
    }

    get interceptors() {
      return this.#interceptors;
    }

    use(...interceptors: Interceptor[]) {
      for (const interceptor of interceptors) {
        this.#interceptors.push(interceptor);
      }

      return this;
    }
  }

  export abstract class Service extends Container.ServiceConstructable {
    abstract setup(register: (route: Route) => void): void;
  }

  export type Request<T1 extends Proto.Message = Proto.Message, T2 extends Proto.Message = Proto.Message> = {
    readonly context: Context;
  } & (
    | {
        readonly stream: true;
        readonly method: Proto.Method<"client-streaming" | "bidi-streaming", T1, T2>;
        readonly message: AsyncIterable<Proto.Message.Type<T1>>;
      }
    | {
        readonly stream: false;
        readonly method: Proto.Method<"server-streaming" | "unary", T1, T2>;
        readonly message: Proto.Message.Type<T1>;
      }
  );

  export type Response<T1 extends Proto.Message = Proto.Message, T2 extends Proto.Message = Proto.Message> = {} & (
    | {
        readonly stream: true;
        readonly method: Proto.Method<"server-streaming" | "bidi-streaming", T1, T2>;
        readonly message: AsyncIterable<Proto.Message.Type<T2>>;
      }
    | {
        readonly stream: false;
        readonly method: Proto.Method<"client-streaming" | "unary", T1, T2>;
        readonly message: Proto.Message.Type<T2>;
      }
  );

  export type Handler = (request: Request) => Promise<Response>;

  export type Interceptor = (handler: Handler) => Handler;

  export type HeadersInit = Exclude<ConstructorParameters<typeof Headers>[0], undefined>;

  // biome-ignore lint/suspicious/noShadowRestrictedNames: x
  export class Error extends globalThis.Error {
    #details: Any[];
    #metadata: Headers;
    #code: Error.Code;

    constructor(code: Error.Code, message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      super(message, { cause });

      this.#details = [...(details || [])];
      this.#metadata = new Headers(metadata);
      this.#code = code;
    }

    get details() {
      return this.#details;
    }

    get metadata() {
      return this.#metadata;
    }

    get code() {
      return this.#code;
    }

    find<T extends Proto.Message.Unknown>(message: Proto.Message<T>) {
      for (const detail of this.#details) {
        if (detail.typeUrl === message.name) {
          try {
            return message.fromAny(detail);
          } catch {}
        }
      }

      return null;
    }

    findAll<T extends Proto.Message.Unknown>(message: Proto.Message<T>) {
      const result: T[] = [];

      for (const detail of this.#details) {
        if (detail.typeUrl === message.name) {
          try {
            const value = message.fromAny(detail);

            if (value) {
              result.push(value);
            }
          } catch {}
        }
      }

      return result;
    }

    withMetadata(metadata: HeadersInit) {
      for (const [k, v] of new Headers(metadata)) {
        this.#metadata.append(k, v);
      }

      return this;
    }

    withDetail(detail: Any): this;
    withDetail<T extends Proto.Message>(message: T, value: Proto.Message.Type<T>): this;

    withDetail<T extends Proto.Message>(...args: [Any] | [message: T, value: Proto.Message.Type<T>]) {
      if (args.length === 1) {
        this.#details.push(args[0]);
      } else {
        this.#details.push(args[0].toAny(args[1]));
      }

      return this;
    }

    static fromUnknown(unknown: unknown, code: Error.Code = Error.Code.Unknown) {
      if (unknown instanceof Error) {
        return unknown;
      }

      let message: string;

      if (unknown instanceof globalThis.Error) {
        message = unknown.message;
      } else if (typeof unknown === "object" && unknown !== null && "message" in unknown && typeof unknown.message === "string") {
        message = unknown.message;
      } else {
        message = unknown ? String(unknown) : "Unknown error.";
      }

      return new Error(code, message, undefined, undefined, unknown);
    }

    static canceled(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.Canceled, message, metadata, details, cause);
    }

    static unknown(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.Unknown, message, metadata, details, cause);
    }

    static invalidArgument(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.InvalidArgument, message, metadata, details, cause);
    }

    static deadlineExceeded(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.DeadlineExceeded, message, metadata, details, cause);
    }

    static notFound(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.NotFound, message, metadata, details, cause);
    }

    static alreadyExists(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.AlreadyExists, message, metadata, details, cause);
    }

    static permissionDenied(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.PermissionDenied, message, metadata, details, cause);
    }

    static resourceExhausted(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.ResourceExhausted, message, metadata, details, cause);
    }

    static failedPrecondition(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.FailedPrecondition, message, metadata, details, cause);
    }

    static aborted(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.Aborted, message, metadata, details, cause);
    }

    static outOfRange(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.OutOfRange, message, metadata, details, cause);
    }

    static unimplemented(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.Unimplemented, message, metadata, details, cause);
    }

    static internal(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.Internal, message, metadata, details, cause);
    }

    static unavailable(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.Unavailable, message, metadata, details, cause);
    }

    static dataLoss(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.DataLoss, message, metadata, details, cause);
    }

    static unauthenticated(message: string, metadata?: HeadersInit, details?: Any[], cause?: unknown) {
      return new Error(Error.Code.Unauthenticated, message, metadata, details, cause);
    }
  }

  export namespace Error {
    export enum Code {
      Canceled = 1,
      Unknown = 2,
      InvalidArgument = 3,
      DeadlineExceeded = 4,
      NotFound = 5,
      AlreadyExists = 6,
      PermissionDenied = 7,
      ResourceExhausted = 8,
      FailedPrecondition = 9,
      Aborted = 10,
      OutOfRange = 11,
      Unimplemented = 12,
      Internal = 13,
      Unavailable = 14,
      DataLoss = 15,
      Unauthenticated = 16,
    }
  }
}
