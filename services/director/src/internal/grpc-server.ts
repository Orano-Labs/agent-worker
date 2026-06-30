import { Code, ConnectError, createContextKey, type HandlerContext, type Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createValidateInterceptor } from "@connectrpc/validate";
import { SignatureIdentitySchema, type SignatureIdentityValid } from "@/generated/proto/api/v1/signature_pb";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { HTTPServer } from "@/internal/http-server";
import { ProjectServiceImplementation } from "@/services/project";
import { SupervisorServiceImplementation } from "@/services/supervisor";
import { UserServiceImplementation } from "@/services/user";

const USER_IDENTITY_CONTEXT = createContextKey<string | null>(null);
const WORKER_IDENTITY_CONTEXT = createContextKey<string | null>(null);

const PRODUCTION = process.env.NODE_ENV === "production";

export class GRPCServer {
  #http: HTTPServer;

  constructor() {
    this.#http = Container.inject(HTTPServer);
  }

  #createValidateInterceptor() {
    return createValidateInterceptor();
  }

  // TODO
  #createLoggingInterceptor() {
    const interceptor: Interceptor = (next) => {
      return async (req) => {
        return next(req);
      };
    };

    return interceptor;
  }

  // TODO
  #createAuthenticatorInterceptor() {
    const parseHeaders = (header: Headers) => {
      let value = header.get("x-request-signature");

      if (value !== null) {
        return [value, false] as const;
      }

      if (!PRODUCTION) {
        value = header.get("x-request-signature-development");

        if (value !== null) {
          return [value, true] as const;
        }
      }

      return null;
    };

    const interceptor: Interceptor = (next) => {
      return async (req) => {
        const headers = parseHeaders(req.header);

        if (headers === null) {
          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        const [hex, dev] = headers;

        let buffer: Buffer;

        try {
          buffer = Buffer.from(hex, "hex");
        } catch {
          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        if (dev) {
          let identity: SignatureIdentityValid;

          try {
            identity = Protobuf.decode(SignatureIdentitySchema, buffer);
          } catch {
            throw new ConnectError("Unauthenticated", Code.Unauthenticated);
          }

          if (identity.identity.case === "user") {
            req.contextValues.set(USER_IDENTITY_CONTEXT, identity.identity.value.id);
          } else if (identity.identity.case === "supervisor") {
            req.contextValues.set(WORKER_IDENTITY_CONTEXT, identity.identity.value.id);
          }

          return next(req);
        }

        throw new ConnectError("Unauthenticated", Code.Unauthenticated);
      };
    };

    return interceptor;
  }

  setup() {
    const handler = connectNodeAdapter({
      grpcWeb: false,
      connect: false,
      grpc: true,
      requestPathPrefix: "/grpc",
      interceptors: [this.#createLoggingInterceptor(), this.#createAuthenticatorInterceptor(), this.#createValidateInterceptor()],
      routes: (router) => {
        Container.inject(UserServiceImplementation).setup(router);
        Container.inject(SupervisorServiceImplementation).setup(router);
        Container.inject(ProjectServiceImplementation).setup(router);
      },
    });

    this.#http.router.all("/grpc/*", (req, res) => {
      handler(req, res);
    });
  }

  getUserIdentityContext(context: HandlerContext) {
    return context.values.get(USER_IDENTITY_CONTEXT);
  }

  getUserIdentityContextMust(context: HandlerContext) {
    const identity = this.getUserIdentityContext(context);

    if (!identity) {
      throw new Error("Missing user identity context.");
    }

    return identity;
  }

  getWorkerIdentityContext(context: HandlerContext) {
    return context.values.get(WORKER_IDENTITY_CONTEXT);
  }

  getWorkerIdentityContextMust(context: HandlerContext) {
    const identity = this.getWorkerIdentityContext(context);

    if (!identity) {
      throw new Error("Missing worker identity context.");
    }

    return identity;
  }
}
