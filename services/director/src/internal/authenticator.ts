import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { Code, ConnectError, createContextKey, type HandlerContext, type Interceptor } from "@connectrpc/connect";
import { SignatureIdentitySchema, type SignatureIdentityValid, SignatureSchema } from "@/generated/proto/api/v1/signature_pb";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { Cache } from "@/internal/cache";
import { Key } from "@/internal/key";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";
import { Variables } from "@/internal/variables";

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
const NONCE_TTL_SEC = 10 * 60;

const PRODUCTION = process.env.NODE_ENV === "production";

export type AuthenticatedIdentity = { case: "user"; userId: string } | { case: "manager" } | { case: "supervisor"; supervisorId: string };

export class Authenticator {
  #logger: Logger;
  #variables: Variables;
  #key: Key;
  #repository: Repository;
  #cache: Cache;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Authenticator");
    this.#variables = Container.inject(Variables);
    this.#key = Container.inject(Key);
    this.#repository = Container.inject(Repository);
    this.#cache = Container.inject(Cache);
  }

  /**
   * Authenticate a request from its headers.
   *
   * Reads the `x-request-signature` (production) or
   * `x-request-signature-development` (non-production) header, verifies the
   * Ed25519 signature (or bypasses verification in dev mode), and returns the
   * authenticated identity.
   */
  async authenticate(headers: Headers): Promise<AuthenticatedIdentity> {
    const raw = this.#parseHeader(headers);

    if (raw === null) {
      throw new ConnectError("Unauthenticated", Code.Unauthenticated);
    }

    const [value, dev] = raw;
    const buffer = this.#decodeBase64(value);

    if (dev) {
      return this.#authenticateDev(buffer);
    }

    return this.#authenticateProduction(buffer);
  }

  #parseHeader(headers: Headers) {
    let value = headers.get("x-request-signature");

    if (value !== null) {
      return [value, false] as const;
    }

    if (!PRODUCTION) {
      value = headers.get("x-request-signature-development");

      if (value !== null) {
        return [value, true] as const;
      }
    }

    return null;
  }

  #decodeBase64(raw: string) {
    try {
      return Buffer.from(raw, "base64");
    } catch (error) {
      this.#logger.warn("Failed to decode Base64 signature header.", {
        err: error,
      });

      throw new ConnectError("Unauthenticated", Code.Unauthenticated);
    }
  }

  async #authenticateDev(buffer: Buffer): Promise<AuthenticatedIdentity> {
    let identity: SignatureIdentityValid;

    try {
      identity = Protobuf.decode(SignatureIdentitySchema, buffer);
    } catch (error) {
      this.#logger.warn("Failed to decode SignatureIdentity from development header.", {
        err: error,
      });

      throw new ConnectError("Unauthenticated", Code.Unauthenticated);
    }

    const validation = Protobuf.validate(SignatureIdentitySchema, identity);

    if (validation.kind !== "valid") {
      this.#logger.warn("Development SignatureIdentity validation failed.", {
        err: validation.error,
      });

      throw new ConnectError("Unauthenticated", Code.Unauthenticated);
    }

    return this.#toIdentity(validation.message);
  }

  async #authenticateProduction(buffer: Buffer): Promise<AuthenticatedIdentity> {
    let signature: ReturnType<typeof Protobuf.decode<typeof SignatureSchema>>;

    try {
      signature = Protobuf.decode(SignatureSchema, buffer);
    } catch (error) {
      this.#logger.warn("Failed to decode Signature protobuf from header.", {
        err: error,
      });

      throw new ConnectError("Unauthenticated", Code.Unauthenticated);
    }

    const validation = Protobuf.validate(SignatureSchema, signature);

    if (validation.kind !== "valid") {
      this.#logger.warn("Signature protobuf validation failed.", {
        err: validation.error,
      });

      throw new ConnectError("Unauthenticated", Code.Unauthenticated);
    }

    const { payload, signature: sigBytes } = validation.message;
    const { nonce, timestamp, identity } = payload;

    this.#checkTimestamp(timestamp);

    const nonceHex = Buffer.from(nonce).toString("hex");
    await this.#checkNonce(nonceHex);

    const identityCase = identity.identity.case;
    const unixSeconds = Math.floor(Protobuf.Timestamp.toDate(timestamp).getTime() / 1000);

    const { message, publicKey } = await this.#resolvePublicKey(identityCase, identity, nonceHex, unixSeconds);

    this.#verifySignature(publicKey, message, Buffer.from(sigBytes), identityCase);

    return this.#toIdentity(identity);
  }

  #checkTimestamp(timestamp: Protobuf.Timestamp) {
    const tsDate = Protobuf.Timestamp.toDate(timestamp);
    const diffMs = Math.abs(Date.now() - tsDate.getTime());

    if (diffMs > TIMESTAMP_WINDOW_MS) {
      this.#logger.warn("Request timestamp outside allowed window.", {
        diffMs,
        windowMs: TIMESTAMP_WINDOW_MS,
      });

      throw new ConnectError("Unauthenticated", Code.Unauthenticated);
    }
  }

  async #checkNonce(nonceHex: string) {
    const nonceKey = `nonce:${nonceHex}`;

    try {
      const result = await this.#cache.client.set(nonceKey, "1", "EX", NONCE_TTL_SEC, "NX");

      if (result !== "OK") {
        this.#logger.warn("Nonce has already been used — possible replay attack.", {
          nonceKey: this.#logger.mask(nonceKey),
        });

        throw new ConnectError("Unauthenticated", Code.Unauthenticated);
      }
    } catch (error) {
      if (error instanceof ConnectError) throw error;

      this.#logger.error("Failed to persist nonce in Redis. Failing closed.", {
        err: error,
      });

      throw new ConnectError("Unauthenticated", Code.Unauthenticated);
    }
  }

  async #resolvePublicKey(
    identityCase: SignatureIdentityValid["identity"]["case"],
    identity: SignatureIdentityValid,
    nonceHex: string,
    unixSeconds: number,
  ) {
    switch (identityCase) {
      case "manager": {
        const pubKeyHex = this.#variables.get("AW_DIRECTOR_MANAGER_PUBLIC_KEY");

        if (!pubKeyHex) {
          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        return {
          message: `${nonceHex}:${unixSeconds}`,
          publicKey: Buffer.from(pubKeyHex, "hex"),
        };
      }

      case "user": {
        const userId = identity.identity.value!.id;

        const user = await this.#repository.client.user.findUnique({
          where: { id: userId, deleteTime: null },
          select: { publicKey: true },
        });

        if (!user) {
          this.#logger.warn("User not found for signature verification.", {
            userId: this.#logger.mask(userId),
          });

          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        return {
          message: `${nonceHex}:${unixSeconds}:${userId}`,
          publicKey: Buffer.from(user.publicKey),
        };
      }

      case "supervisor": {
        const supervisorId = identity.identity.value!.id;

        const supervisor = await this.#repository.client.supervisor.findUnique({
          where: { id: supervisorId, deleteTime: null },
          select: { publicKey: true },
        });

        if (!supervisor) {
          this.#logger.warn("Supervisor not found for signature verification.", {
            supervisorId: this.#logger.mask(supervisorId),
          });

          throw new ConnectError("Unauthenticated", Code.Unauthenticated);
        }

        return {
          message: `${nonceHex}:${unixSeconds}:${supervisorId}`,
          publicKey: Buffer.from(supervisor.publicKey),
        };
      }

      default:
        this.#logger.warn("Unknown identity case.", {
          case: identityCase,
        });

        throw new ConnectError("Unauthenticated", Code.Unauthenticated);
    }
  }

  #verifySignature(publicKey: Buffer, message: string, sigBytes: Buffer, identityCase: string) {
    let verified: boolean;

    try {
      verified = this.#key.verifyED25519(publicKey, Buffer.from(message, "utf-8"), sigBytes);
    } catch (error) {
      this.#logger.error("Ed25519 signature verification threw an exception.", {
        err: error,
      });

      throw new ConnectError("Unauthenticated", Code.Unauthenticated);
    }

    if (!verified) {
      this.#logger.warn("Ed25519 signature verification failed.", {
        identityCase,
      });

      throw new ConnectError("Unauthenticated", Code.Unauthenticated);
    }
  }

  #toIdentity(message: SignatureIdentityValid): AuthenticatedIdentity {
    const { identity } = message;

    switch (identity.case) {
      case "user":
        return { case: "user", userId: identity.value.id };
      case "manager":
        return { case: "manager" };
      case "supervisor":
        return { case: "supervisor", supervisorId: identity.value.id };
      default:
        this.#logger.warn("Unknown identity case.", {
          case: identity.case,
        });

        throw new ConnectError("Unauthenticated", Code.Unauthenticated);
    }
  }

  static createRequestId() {
    const buffer = Buffer.alloc(12);

    buffer.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
    buffer.set(randomBytes(8), 4);

    return buffer.toString("hex");
  }
}
