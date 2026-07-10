import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import { Code, ConnectError, createContextKey, type HandlerContext, type Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createValidateInterceptor } from "@connectrpc/validate";
import { default as Router } from "find-my-way";
import { SignatureIdentitySchema, type SignatureIdentityValid, SignatureSchema } from "@/generated/proto/api/v1/signature_pb";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { Result } from "@/helpers/result";
import { Cache } from "@/internal/cache";
import { Key } from "@/internal/key";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";
import { Variables } from "@/internal/variables";
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

const PRODUCTION = process.env.NODE_ENV === "production";

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
  #variables: Variables;
  #server?: Http2SecureServer;
  #sockets: Set<Socket>;
  #key: Key;
  #repository: Repository;
  #cache: Cache;

  constructor() {
    this.#logger = Container.inject(Logger).scope("GRPCServer");
    this.#variables = Container.inject(Variables);
    this.#sockets = new Set();
    this.#key = Container.inject(Key);
    this.#repository = Container.inject(Repository);
    this.#cache = Container.inject(Cache);
  }

  #createRequestIdInterceptor() {
    /**
     * Generate an ObjectID-compatible 24-character hex string.
     *
     * The timestamp prefix allows extracting the request creation time
     * without any lookup — useful for debugging and log correlation.
     */
    const generateRequestId = () => {
      const buffer = Buffer.alloc(12);

      buffer.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
      buffer.set(randomBytes(8), 4);

      return buffer.toString("hex");
    };

    const interceptor: Interceptor = (next) => {
      return async (req) => {
        req.contextValues.set(REQUEST_ID_CONTEXT, generateRequestId());

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
    /** Maximum allowed clock skew for request timestamps (5 minutes in ms). */
    const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

    /** TTL in seconds for nonce entries in Redis (must ≥ TIMESTAMP_WINDOW). */
    const NONCE_TTL_SEC = 10 * 60;

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

    const managerPubKeyHex = this.#variables.get("AW_DIRECTOR_MANAGER_PUBLIC_KEY");

    if (!managerPubKeyHex) {
      this.#logger.warn("Manager public key is not configured. Manager identity authentication will be unavailable.");
    }

    const interceptor: Interceptor = (next) => {
      return async (req) => {
        const reqId = req.contextValues.get(REQUEST_ID_CONTEXT) || "??";
        const headers = parseHeaders(req.header);
        const logger = this.#logger.with({ requestId: reqId });

        if (headers === null) {
          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        const [raw, dev] = headers;

        let buffer: Buffer;

        try {
          buffer = Buffer.from(raw, "base64");
        } catch (error) {
          logger.warn("Failed to decode Base64 signature header.", {
            err: error,
          });

          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        if (dev) {
          let identity: SignatureIdentityValid;

          try {
            identity = Protobuf.decode(SignatureIdentitySchema, buffer);
          } catch (error) {
            logger.warn("Failed to decode SignatureIdentity from development header.", {
              err: error,
            });

            throw new ConnectError("Unauthenticated", Code.Unauthenticated);
          }

          const validation = Protobuf.validate(SignatureIdentitySchema, identity);

          if (validation.kind !== "valid") {
            logger.warn("Development SignatureIdentity validation failed.", {
              err: validation.error,
            });

            throw new ConnectError("Unauthenticated", Code.Unauthenticated);
          }

          const message = validation.message;

          if (message.identity.case === "user") {
            req.contextValues.set(USER_IDENTITY_CONTEXT, message.identity.value.id);
          } else if (message.identity.case === "manager") {
            // Manager has no id — presence alone is sufficient.
          } else if (message.identity.case === "supervisor") {
            req.contextValues.set(SUPERVISOR_IDENTITY_CONTEXT, message.identity.value.id);
          } else {
            logger.warn("Unknown identity case in development mode.", {
              case: message.identity.case,
            });

            throw new ConnectError("Unauthenticated", Code.Unauthenticated);
          }

          req.contextValues.set(IDENTITY_CASE_CONTEXT, message.identity.case);

          logger.debug("Development request authenticated.", {
            identityCase: message.identity.case,
          });

          return next(req);
        }

        let signature: ReturnType<typeof Protobuf.decode<typeof SignatureSchema>>;

        try {
          signature = Protobuf.decode(SignatureSchema, buffer);
        } catch (error) {
          logger.warn("Failed to decode Signature protobuf from header.", {
            err: error,
          });

          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        // Validate that all required fields conform to the proto spec.
        const validation = Protobuf.validate(SignatureSchema, signature);

        if (validation.kind !== "valid") {
          logger.warn("Signature protobuf validation failed.", {
            err: validation.error,
          });

          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        const { payload, signature: sigBytes } = validation.message;
        const { nonce, timestamp, identity } = payload;

        const tsDate = Protobuf.Timestamp.toDate(timestamp);
        const now = Date.now();
        const diffMs = Math.abs(now - tsDate.getTime());

        if (diffMs > TIMESTAMP_WINDOW_MS) {
          logger.warn("Request timestamp outside allowed window.", {
            diffMs,
            windowMs: TIMESTAMP_WINDOW_MS,
          });

          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        const nonceHex = Buffer.from(nonce).toString("hex");
        const nonceKey = `nonce:${nonceHex}`;

        try {
          const nonceResult = await this.#cache.client.set(nonceKey, "1", "EX", NONCE_TTL_SEC, "NX");

          if (nonceResult !== "OK") {
            logger.warn("Nonce has already been used — possible replay attack.", {
              nonceKey: logger.mask(nonceKey),
            });

            throw new ConnectError("Unauthenticated", Code.Unauthenticated);
          }
        } catch (error) {
          if (error instanceof ConnectError) throw error;

          logger.error("Failed to persist nonce in Redis. Failing closed.", {
            err: error,
          });

          // If Redis is unavailable, fail closed rather than silently
          // allowing potentially replayed requests.
          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        const unixSeconds = Math.floor(tsDate.getTime() / 1000);
        const identityCase = identity.identity.case;

        let messageToVerify: string;
        let publicKey: Buffer;

        switch (identityCase) {
          case "manager": {
            messageToVerify = `${nonceHex}:${unixSeconds}`;

            const managerPubKeyHex = this.#variables.get("AW_DIRECTOR_MANAGER_PUBLIC_KEY");

            if (!managerPubKeyHex) {
              throw new ConnectError("Unauthenticated", Code.Unauthenticated);
            }

            publicKey = Buffer.from(managerPubKeyHex, "hex");

            break;
          }

          case "user": {
            const userId = identity.identity.value.id;

            messageToVerify = `${nonceHex}:${unixSeconds}:${userId}`;

            const user = await this.#repository.client.user.findUnique({
              where: {
                id: userId,
                deleteTime: null,
              },
              select: {
                publicKey: true,
              },
            });

            if (!user) {
              logger.warn("User not found or disabled for signature verification.", {
                userId: logger.mask(userId),
              });

              throw new ConnectError("Unauthenticated", Code.Unauthenticated);
            }

            publicKey = Buffer.from(user.publicKey);

            break;
          }

          case "supervisor": {
            const supervisorId = identity.identity.value.id;

            messageToVerify = `${nonceHex}:${unixSeconds}:${supervisorId}`;

            const supervisor = await this.#repository.client.supervisor.findUnique({
              where: {
                id: supervisorId,
                deleteTime: null,
              },
              select: {
                publicKey: true,
              },
            });

            if (!supervisor) {
              logger.warn("Supervisor not found for signature verification.", {
                supervisorId: logger.mask(supervisorId),
              });

              throw new ConnectError("Unauthenticated", Code.Unauthenticated);
            }

            publicKey = Buffer.from(supervisor.publicKey);

            break;
          }

          default:
            logger.warn("Unknown identity case in production mode.", {
              case: identityCase,
            });

            throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        let verified: boolean;

        try {
          verified = this.#key.verifyED25519(publicKey, Buffer.from(messageToVerify, "utf-8"), Buffer.from(sigBytes));
        } catch (error) {
          logger.error("Ed25519 signature verification threw an exception.", {
            err: error,
          });

          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        if (!verified) {
          logger.warn("Ed25519 signature verification failed.", {
            identityCase,
          });

          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        if (identityCase === "user") {
          req.contextValues.set(USER_IDENTITY_CONTEXT, identity.identity.value.id);
        } else if (identityCase === "supervisor") {
          req.contextValues.set(SUPERVISOR_IDENTITY_CONTEXT, identity.identity.value.id);
        }

        req.contextValues.set(IDENTITY_CASE_CONTEXT, identityCase);

        logger.debug("Request authenticated successfully.", {
          identityCase,
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
