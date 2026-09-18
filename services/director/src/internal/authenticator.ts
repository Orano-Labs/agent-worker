import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { SignatureIdentitySchema, type SignatureIdentityValid, SignatureSchema } from "@/generated/proto/api/v1/signature_pb";
import { Protobuf } from "@/helpers/protobuf";
import type { Cache } from "@/internal/cache";
import type { Key } from "@/internal/key";
import type { Repository } from "@/internal/repository";

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
const NONCE_TTL_SEC = 10 * 60;

export class Authenticator extends Container.ServiceConstructable {
  #logger: Logger;
  #environment: Environment;
  #key: Key;
  #repository: Repository;
  #cache: Cache;

  constructor(...deps: [Environment, Logger, Key, Repository, Cache]) {
    super();

    this.#logger = deps[1].namespace("Authenticator");
    this.#environment = deps[0];
    this.#key = deps[2];
    this.#repository = deps[3];
    this.#cache = deps[4];
  }

  /**
   * Authenticate a request from its headers.
   *
   * Reads the `x-request-signature` (production) or
   * `x-request-signature-development` (non-production) header, verifies the
   * Ed25519 signature (or bypasses verification in dev mode), and returns the
   * authenticated identity.
   */
  async authenticate(headers: Headers) {
    const raw = this.#parseHeader(headers);

    if (raw === null) {
      throw new Error("Missing signature header");
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

    if (this.#environment.mode !== Environment.Mode.Production) {
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

      throw new Error("Invalid signature Base64 encoding");
    }
  }

  async #authenticateDev(buffer: Buffer) {
    let identity: SignatureIdentityValid;

    try {
      identity = Protobuf.decode(SignatureIdentitySchema, buffer);
    } catch (error) {
      this.#logger.warn("Failed to decode SignatureIdentity from development header.", {
        err: error,
      });

      throw new Error("Invalid development identity protobuf");
    }

    const validation = Protobuf.validate(SignatureIdentitySchema, identity);

    if (validation.kind !== "valid") {
      this.#logger.warn("Development SignatureIdentity validation failed.", {
        err: validation.error,
      });

      throw new Error("Development identity validation failed");
    }

    return this.#toIdentity(validation.message);
  }

  async #authenticateProduction(buffer: Buffer) {
    let signature: ReturnType<typeof Protobuf.decode<typeof SignatureSchema>>;

    try {
      signature = Protobuf.decode(SignatureSchema, buffer);
    } catch (error) {
      this.#logger.warn("Failed to decode Signature protobuf from header.", {
        err: error,
      });

      throw new Error("Invalid signature protobuf");
    }

    const validation = Protobuf.validate(SignatureSchema, signature);

    if (validation.kind !== "valid") {
      this.#logger.warn("Signature protobuf validation failed.", {
        err: validation.error,
      });

      throw new Error("Signature protobuf validation failed");
    }

    const { payload, signature: sigBytes } = validation.message;
    const { nonce, timestamp, identity } = payload;

    this.#checkTimestamp(timestamp);

    const nonceHex = Buffer.from(nonce).toString("hex");
    await this.#checkNonce(nonceHex);
    const unixSeconds = Math.floor(Protobuf.Timestamp.toDate(timestamp).getTime() / 1000);

    const { message, publicKey } = await this.#resolvePublicKey(identity, nonceHex, unixSeconds);

    this.#verifySignature(publicKey, message, Buffer.from(sigBytes));

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

      throw new Error("Request timestamp outside allowed window");
    }
  }

  async #checkNonce(nonceHex: string) {
    const nonceKey = `nonce:${nonceHex}`;

    try {
      const result = await this.#cache.client.set(nonceKey, "1", "EX", NONCE_TTL_SEC, "NX");

      if (result !== "OK") {
        this.#logger.warn("Nonce has already been used — possible replay attack.", {
          nonceKey: nonceKey,
        });

        throw new Error("Nonce already used");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Nonce")) throw error;

      this.#logger.error("Failed to persist nonce in Redis. Failing closed.", {
        err: error,
      });

      throw new Error("Nonce persistence failed");
    }
  }

  async #resolvePublicKey(identity: SignatureIdentityValid, nonceHex: string, unixSeconds: number) {
    switch (identity.identity.case) {
      case "manager": {
        const pubKeyHex = this.#environment.get("AW_DIRECTOR_MANAGER_PUBLIC_KEY");

        if (!pubKeyHex) {
          throw new Error("Manager public key not configured");
        }

        return {
          message: `${nonceHex}:${unixSeconds}`,
          publicKey: Buffer.from(pubKeyHex, "hex"),
        };
      }

      case "user": {
        const userId = identity.identity.value.id;

        const user = await this.#repository.client.user.findUnique({
          where: { id: userId, deleteTime: null },
          select: { publicKey: true },
        });

        if (!user) {
          this.#logger.warn("User not found for signature verification.", {
            userId: userId,
          });

          throw new Error("User not found");
        }

        return {
          message: `${nonceHex}:${unixSeconds}:${userId}`,
          publicKey: Buffer.from(user.publicKey),
        };
      }

      case "supervisor": {
        const supervisorId = identity.identity.value.id;

        const supervisor = await this.#repository.client.supervisor.findUnique({
          where: { id: supervisorId, deleteTime: null },
          select: { publicKey: true },
        });

        if (!supervisor) {
          this.#logger.warn("Supervisor not found for signature verification.", {
            supervisorId: supervisorId,
          });

          throw new Error("Supervisor not found");
        }

        return {
          message: `${nonceHex}:${unixSeconds}:${supervisorId}`,
          publicKey: Buffer.from(supervisor.publicKey),
        };
      }

      default:
        this.#logger.warn("Unknown identity case.", {
          case: identity.identity.case,
        });

        throw new Error("Unknown identity case");
    }
  }

  #verifySignature(publicKey: Buffer, message: string, sigBytes: Buffer) {
    let verified: boolean;

    try {
      verified = this.#key.verifyED25519(publicKey, Buffer.from(message, "utf-8"), sigBytes);
    } catch (error) {
      this.#logger.error("Ed25519 signature verification threw an exception.", {
        err: error,
      });

      throw new Error("Signature verification error");
    }

    if (!verified) {
      throw new Error("Signature verification failed");
    }
  }

  #toIdentity(message: SignatureIdentityValid): Authenticator.Identity {
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

        throw new Error("Unknown identity case");
    }
  }
}

export namespace Authenticator {
  export type Identity =
    | {
        case: "user";
        userId: string;
      }
    | {
        case: "manager";
      }
    | {
        case: "supervisor";
        supervisorId: string;
      };
}
