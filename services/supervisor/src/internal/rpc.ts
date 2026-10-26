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
import { ConnectError, HandlerContext, Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { Server } from "@/internal/server";

export class RPC extends Container.ServiceConstructable {
  #server: Server;
  #logger: Logger;
  #controller: AbortController;

  constructor(...deps: [Server, Logger]) {
    super();

    this.#server = deps[0];
    this.#logger = deps[1].namespace("RPC");
    this.#controller = new AbortController();
  }

  #createContext(_: RPC.Route, context: HandlerContext) {
    return {
      url: context.url,
      signal: context.signal,
      incomingHeaders: context.requestHeader,
      outgoingHeaders: context.responseHeader,
      outgoingTrailers: context.responseTrailer,
      deadline: context.timeoutMs,
    } satisfies RPC.Context as RPC.Context;
  }

  #createUnaryHandler(route: RPC.Route<Proto.Method<"unary">>) {
    const handler = async (request: Extract<RPC.Request, { stream: false }>): Promise<Extract<RPC.Response, { stream: false }>> => {
      return {
        stream: false,
        method: route.method,
        message: await route.implementation(request.message, request.context),
      };
    };

    return handler;
  }

  #createClientStreamHandler(route: RPC.Route<Proto.Method<"client-streaming">>) {
    const handler = async (request: Extract<RPC.Request, { stream: true }>): Promise<Extract<RPC.Response, { stream: false }>> => {
      return {
        stream: false,
        method: route.method,
        message: await route.implementation(request.message, request.context),
      };
    };

    return handler;
  }

  #createServerStreamHandler(route: RPC.Route<Proto.Method<"server-streaming">>) {
    const handler = async (request: Extract<RPC.Request, { stream: false }>): Promise<Extract<RPC.Response, { stream: true }>> => {
      return {
        stream: true,
        method: route.method,
        message: route.implementation(request.message, request.context),
      };
    };

    return handler;
  }

  #createBidiStreamHandler(route: RPC.Route<Proto.Method<"bidi-streaming">>) {
    const handler = async (request: Extract<RPC.Request, { stream: true }>): Promise<Extract<RPC.Response, { stream: true }>> => {
      return {
        stream: true,
        method: route.method,
        message: route.implementation(request.message, request.context),
      };
    };

    return handler;
  }

  #createUnaryAdapter(route: RPC.Route<Proto.Method<"unary">>) {
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

  #createClientStreamAdapter(route: RPC.Route<Proto.Method<"client-streaming">>) {
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

  #createServerStreamAdapter(route: RPC.Route<Proto.Method<"server-streaming">>) {
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

  #createBidiStreamAdapter(route: RPC.Route<Proto.Method<"bidi-streaming">>) {
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
              http,
            });
          } else if (duration >= slowRequestThreshold) {
            this.#logger.warn(`Method ${method} completed slowly in ${duration.toFixed(2)}ms (threshold: ${slowRequestThreshold}ms)`, {
              http,
            });
          } else {
            this.#logger.info(`Method ${method} completed successfully in ${duration.toFixed(2)}ms`, {
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

      const internal = RPC.Error.fromUnknown(error, RPC.Error.Code.Internal);
      const final = new ConnectError(internal.message, internal.code, internal.metadata, undefined, error);

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
    const adapter = connectNodeAdapter({
      grpc: false,
      grpcWeb: false,
      connect: true,
      requestPathPrefix: "/rpc",
      routes: (router) => {
        const register = (route: RPC.Route) => {
          const schema = route.method.schema as
            | DescMethodBiDiStreaming
            | DescMethodClientStreaming
            | DescMethodServerStreaming
            | DescMethodUnary;

          if (schema.methodKind === "unary") {
            router.rpc(schema, this.#createUnaryAdapter(route as RPC.Route<Proto.Method<"unary">>));
          }

          if (schema.methodKind === "client_streaming") {
            router.rpc(schema, this.#createClientStreamAdapter(route as RPC.Route<Proto.Method<"client-streaming">>));
          }

          if (schema.methodKind === "server_streaming") {
            router.rpc(schema, this.#createServerStreamAdapter(route as RPC.Route<Proto.Method<"server-streaming">>));
          }

          if (schema.methodKind === "bidi_streaming") {
            router.rpc(schema, this.#createBidiStreamAdapter(route as RPC.Route<Proto.Method<"bidi-streaming">>));
          }
        };
      },
      shutdownSignal: this.#controller.signal,
      interceptors: [
        //
        this.#createConnectLoggingInterceptor(),
        this.#createConnectErrorTransformationInterceptor(),
        this.#createConnectRequestValidationInterceptor(),
      ],
    });

    this.#server.router.all("/rpc/*", adapter);
  }

  override async dispose(reason: unknown) {
    this.#controller.abort(reason);
  }

  static route<T extends Proto.Method = Proto.Method>(method: T, implementation: Proto.Service.Implementation.Method<T, RPC.Context>) {
    return new RPC.Route(method, implementation);
  }
}

export namespace RPC {
  export type Context = {
    readonly url: string;
    readonly signal: AbortSignal;
    readonly incomingHeaders: Headers;
    readonly outgoingHeaders: Headers;
    readonly outgoingTrailers: Headers;
    readonly deadline: () => number | undefined;
  };

  export class Route<T extends Proto.Method = Proto.Method> {
    #method: T;
    #implementation: Proto.Service.Implementation.Method<T, Context>;

    constructor(method: T, implementation: Proto.Service.Implementation.Method<T, Context>) {
      this.#method = method;
      this.#implementation = implementation;
    }

    get method() {
      return this.#method;
    }

    get implementation() {
      return this.#implementation;
    }
  }

  export type HeadersInit = Exclude<ConstructorParameters<typeof Headers>[0], undefined>;

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

  // biome-ignore lint/suspicious/noShadowRestrictedNames: x
  export class Error extends globalThis.Error {
    #metadata: Headers;
    #code: Error.Code;

    constructor(code: Error.Code, message: string, metadata?: HeadersInit, cause?: unknown) {
      super(message, { cause });

      this.#metadata = new Headers(metadata);
      this.#code = code;
    }

    get metadata() {
      return this.#metadata;
    }

    get code() {
      return this.#code;
    }

    withMetadata(metadata: HeadersInit) {
      for (const [k, v] of new Headers(metadata)) {
        this.#metadata.append(k, v);
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

      return new Error(code, message, undefined, unknown);
    }

    static canceled(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.Canceled, message, metadata, cause);
    }

    static unknown(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.Unknown, message, metadata, cause);
    }

    static invalidArgument(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.InvalidArgument, message, metadata, cause);
    }

    static deadlineExceeded(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.DeadlineExceeded, message, metadata, cause);
    }

    static notFound(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.NotFound, message, metadata, cause);
    }

    static alreadyExists(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.AlreadyExists, message, metadata, cause);
    }

    static permissionDenied(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.PermissionDenied, message, metadata, cause);
    }

    static resourceExhausted(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.ResourceExhausted, message, metadata, cause);
    }

    static failedPrecondition(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.FailedPrecondition, message, metadata, cause);
    }

    static aborted(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.Aborted, message, metadata, cause);
    }

    static outOfRange(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.OutOfRange, message, metadata, cause);
    }

    static unimplemented(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.Unimplemented, message, metadata, cause);
    }

    static internal(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.Internal, message, metadata, cause);
    }

    static unavailable(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.Unavailable, message, metadata, cause);
    }

    static dataLoss(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.DataLoss, message, metadata, cause);
    }

    static unauthenticated(message: string, metadata?: HeadersInit, cause?: unknown) {
      return new Error(Error.Code.Unauthenticated, message, metadata, cause);
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

    export type Detail = { type: string; value: Uint8Array };
  }
}
