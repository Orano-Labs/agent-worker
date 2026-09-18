import { randomBytes } from "node:crypto";
import { Container } from "@aw/container";
import type { Logger } from "@aw/logging";
import { Code, ConnectError, type ConnectRouter, createContextKey, type HandlerContext, type Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createValidateInterceptor } from "@connectrpc/validate";
import type { SignatureIdentityValid } from "@/generated/proto/api/v1/signature_pb";
import type { Authenticator } from "@/internal/authenticator";
import { HTTPServer } from "@/internal/http-server";

const REQUEST_ID_CONTEXT = createContextKey<string | null>(null);

const USER_IDENTITY_CONTEXT = createContextKey<string | null>(null);
const SUPERVISOR_IDENTITY_CONTEXT = createContextKey<string | null>(null);
const IDENTITY_CASE_CONTEXT = createContextKey<SignatureIdentityValid["identity"]["case"] | null>(null);

/**
 * Access control map — service type name → permitted identity cases.
 *
 * Identity cases are defined by the {@link SignatureIdentity.identity} oneof:
 * - `"user"`       — end-user managing their own projects / templates
 * - `"manager"`    — administrative access to all services
 * - `"supervisor"` — Supervisor node fetching tasks and reporting metrics
 */
const SERVICE_ACCESS: Readonly<Record<string, ReadonlyArray<SignatureIdentityValid["identity"]["case"]>>> = {
  "api.v1.UserService": ["manager"],
  "api.v1.SupervisorService": ["manager"],
  "api.v1.SupervisorPortalService": ["supervisor"],
  "api.v1.ProjectService": ["user"],
  "api.v1.TemplateService": ["user"],
  "api.v1.FileUploadService": ["user", "manager"],
  "api.v1.FileSystemService": ["user", "manager"],
};

export class GRPCHandler extends Container.ServiceConstructable {
  #logger: Logger;
  #authenticator: Authenticator;
  #handler: ReturnType<typeof connectNodeAdapter>;

  constructor(...deps: [Logger, Authenticator, GRPCHandler.ServiceImplementation[]]) {
    super();

    this.#logger = deps[0].namespace("GRPCHandler");
    this.#authenticator = deps[1];

    this.#handler = connectNodeAdapter({
      grpcWeb: true,
      connect: true,
      grpc: false,
      requestPathPrefix: "/grpc",
      interceptors: [
        this.#createRequestIdInterceptor(),
        this.#createLoggingInterceptor(),
        this.#createAuthenticatorInterceptor(),
        this.#createAccessControlInterceptor(),
        this.#createValidateInterceptor(),
      ],
      routes: (router) => {
        for (const service of deps[2]) {
          service.setup(router);
        }
      },
    });
  }

  // get routes() {
  //   return [
  //     {
  //       kind: "request",
  //       method: HTTPServer.Method.Any,
  //       path: "grpc/**:rest",
  //       handler: ({ req, res }) => {
  //         this.#handler(req, res);
  //       },
  //     },
  //   ] satisfies HTTPServer.Route[];
  // }

  #createRequestId() {
    const buffer = Buffer.alloc(12);

    buffer.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
    buffer.set(randomBytes(8), 4);

    return buffer.toString("hex");
  }

  #createRequestIdInterceptor() {
    const interceptor: Interceptor = (next) => {
      return async (req) => {
        req.contextValues.set(REQUEST_ID_CONTEXT, this.#createRequestId());

        return next(req);
      };
    };

    return interceptor;
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

  #createAuthenticatorInterceptor() {
    const interceptor: Interceptor = (next) => {
      return async (req) => {
        const reqId = req.contextValues.get(REQUEST_ID_CONTEXT) || "??";
        const logger = this.#logger.binding({ requestId: reqId });

        let identity: Authenticator.Identity;

        try {
          identity = await this.#authenticator.authenticate(req.header);
        } catch (error) {
          logger.warn("Authentication failed.", {
            reason: error instanceof Error ? error.message : String(error),
          });

          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        switch (identity.case) {
          case "user":
            req.contextValues.set(USER_IDENTITY_CONTEXT, identity.userId);
            break;
          case "supervisor":
            req.contextValues.set(SUPERVISOR_IDENTITY_CONTEXT, identity.supervisorId);
            break;
        }

        req.contextValues.set(IDENTITY_CASE_CONTEXT, identity.case);

        logger.debug("Request authenticated.", {
          identityCase: identity.case,
        });

        return next(req);
      };
    };

    return interceptor;
  }

  #createAccessControlInterceptor() {
    const interceptor: Interceptor = (next) => {
      return async (req) => {
        const identityCase = req.contextValues.get(IDENTITY_CASE_CONTEXT);
        const serviceName = req.service.typeName;

        const allowed = SERVICE_ACCESS[serviceName];

        if (allowed && identityCase && !allowed.includes(identityCase)) {
          throw new ConnectError("Access denied.", Code.PermissionDenied);
        }

        return next(req);
      };
    };

    return interceptor;
  }

  static getIdentityCaseContext(context: HandlerContext) {
    return context.values.get(IDENTITY_CASE_CONTEXT);
  }

  static getIdentityCaseContextMust(context: HandlerContext) {
    const identityCase = GRPCHandler.getIdentityCaseContext(context);

    if (!identityCase) {
      throw new Error("Missing identity case context.");
    }

    return identityCase;
  }

  static getUserIdentityContext(context: HandlerContext) {
    return context.values.get(USER_IDENTITY_CONTEXT);
  }

  static getUserIdentityContextMust(context: HandlerContext) {
    const identity = GRPCHandler.getUserIdentityContext(context);

    if (!identity) {
      throw new Error("Missing user identity context.");
    }

    return identity;
  }

  static getSupervisorIdentityContext(context: HandlerContext) {
    return context.values.get(SUPERVISOR_IDENTITY_CONTEXT);
  }

  static getSupervisorIdentityContextMust(context: HandlerContext) {
    const identity = GRPCHandler.getSupervisorIdentityContext(context);

    if (!identity) {
      throw new Error("Missing supervisor identity context.");
    }

    return identity;
  }

  static getRequestIdContext(context: HandlerContext) {
    return context.values.get(REQUEST_ID_CONTEXT);
  }

  static getRequestIdContextMust(context: HandlerContext) {
    const requestId = GRPCHandler.getRequestIdContext(context);

    if (!requestId) {
      throw new Error("Missing request ID context.");
    }

    return requestId;
  }
}

export namespace GRPCHandler {
  export abstract class ServiceImplementation extends Container.ServiceConstructable {
    abstract setup(router: ConnectRouter): void;
  }
}
