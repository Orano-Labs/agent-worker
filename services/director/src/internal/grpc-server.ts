import { readFile } from "node:fs/promises";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import { Code, ConnectError, createContextKey, type HandlerContext, type Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createValidateInterceptor } from "@connectrpc/validate";
import { default as Router } from "find-my-way";
import type { SignatureIdentityValid } from "@/generated/proto/api/v1/signature_pb";
import { Container } from "@/helpers/container";
import { Result } from "@/helpers/result";
import { Authenticator } from "@/internal/authenticator";
import { Logger } from "@/internal/logger";
import { ProjectServiceImplementation } from "@/services/project";
import { SupervisorServiceImplementation } from "@/services/supervisor";
import { SupervisorPortalServiceImplementation } from "@/services/supervisor-portal";
import { TemplateServiceImplementation } from "@/services/template";
import { UserServiceImplementation } from "@/services/user";

const SHUTDOWN_GRACE_MS = 5_000;

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
};

export class GRPCServer {
  #logger: Logger;
  #server?: Http2SecureServer;
  #sockets: Set<Socket>;
  #authenticator: Authenticator;

  constructor() {
    this.#logger = Container.inject(Logger).scope("GRPCServer");
    this.#sockets = new Set();
    this.#authenticator = Container.inject(Authenticator);
  }

  #createRequestIdInterceptor() {
    const interceptor: Interceptor = (next) => {
      return async (req) => {
        req.contextValues.set(REQUEST_ID_CONTEXT, Authenticator.createRequestId());

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
        const logger = this.#logger.with({ requestId: reqId });

        const identity = await this.#authenticator.authenticate(req.header);

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

  async init(): Promise<Result<void, Error>> {
    const port = this.#variables.getNumber("AW_DIRECTOR_GRPC_PORT", 50051);

    const keyFile = this.#variables.get("AW_DIRECTOR_GRPC_CA_KEY");
    const certFile = this.#variables.get("AW_DIRECTOR_GRPC_CA_CERTIFICATE");

    if (!keyFile || !certFile) {
      return Result.error(new Error("GRPC_CA_KEY and GRPC_CA_CERTIFICATE must be set to enable http2."));
    }

    const keyPath = resolve(keyFile);
    const certPath = resolve(certFile);

    let key: string;
    let cert: string;

    try {
      key = await readFile(keyPath, "utf-8");
      cert = await readFile(certPath, "utf-8");
    } catch (error) {
      return Result.error(new Error("Failed to read key or cert file.", { cause: error }));
    }

    const router = Router<Router.HTTPVersion.V2>();
    const handler = connectNodeAdapter({
      grpcWeb: false,
      connect: true,
      grpc: true,
      requestPathPrefix: "/grpc",
      interceptors: [
        this.#createRequestIdInterceptor(),
        this.#createLoggingInterceptor(),
        this.#createAuthenticatorInterceptor(),
        this.#createAccessControlInterceptor(),
        this.#createValidateInterceptor(),
      ],
      routes: (router) => {
        Container.inject(UserServiceImplementation).setup(router);
        Container.inject(SupervisorServiceImplementation).setup(router);
        Container.inject(SupervisorPortalServiceImplementation).setup(router);
        Container.inject(ProjectServiceImplementation).setup(router);
        Container.inject(TemplateServiceImplementation).setup(router);
      },
    });

    router.all("/grpc/*", (req, res) => {
      handler(req, res);
    });

    const server = createSecureServer({ key, cert }, router.lookup.bind(router));

    // Track open connections so shutdown can drain them.
    server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => {
        this.#sockets.delete(socket);
      });
    });

    this.#server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const callback = async () => {
          this.#logger.info(`GRPC server is running on port ${port}`);

          const os = await import("node:os");
          const interfaces = os.networkInterfaces();

          const endpoints: unknown[] = [];

          for (const [_, ifaces] of Object.entries(interfaces)) {
            if (!ifaces) continue;

            for (const iface of ifaces) {
              if (iface.family === "IPv4") {
                endpoints.push(`http://${iface.address}:${port}`);
              }
            }
          }

          this.#logger.info("Server is listening on all interfaces. Available endpoints:", {
            endpoints,
          });

          resolve();
        };

        server.listen(port, callback);
        server.on("error", reject);
      });
    } catch (error) {
      return Result.error(new Error("Failed to start GRPC server.", { cause: error }));
    }

    return Result.ok();
  }

  /**
   * Gracefully shut down the gRPC server.
   *
   * 1. Stops accepting new connections via {@link Http2SecureServer.close}.
   * 2. Waits up to {@link SHUTDOWN_GRACE_MS} for in-flight requests to complete.
   * 3. Force-destroys any remaining sockets.
   */
  async shutdown(): Promise<void> {
    if (!this.#server) {
      return;
    }

    this.#logger.info("Shutting down gRPC server...");

    const server = this.#server;

    // Stop accepting new connections.
    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // Give existing connections a grace period, then destroy them.
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.#sockets.size > 0) {
          this.#logger.warn("Force-closing remaining gRPC connections", {
            count: this.#sockets.size,
          });
        }

        for (const socket of this.#sockets) {
          socket.destroy();
        }

        resolve();
      }, SHUTDOWN_GRACE_MS);
    });

    await Promise.race([closed, timeout]);

    this.#logger.info("GRPC server shut down.");
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

  getSupervisorIdentityContext(context: HandlerContext) {
    return context.values.get(SUPERVISOR_IDENTITY_CONTEXT);
  }

  getSupervisorIdentityContextMust(context: HandlerContext) {
    const identity = this.getSupervisorIdentityContext(context);

    if (!identity) {
      throw new Error("Missing supervisor identity context.");
    }

    return identity;
  }

  getRequestIdContext(context: HandlerContext) {
    return context.values.get(REQUEST_ID_CONTEXT);
  }

  getRequestIdContextMust(context: HandlerContext) {
    const requestId = this.getRequestIdContext(context);

    if (!requestId) {
      throw new Error("Missing request ID context.");
    }

    return requestId;
  }
}
