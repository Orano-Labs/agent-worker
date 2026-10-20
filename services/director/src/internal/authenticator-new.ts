import { createPublicKey, generateKeyPair, verify } from "node:crypto";

import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";

import { Redis } from "@/internal/redis";
import { Supervisors } from "@/internal/supervisors";
import { Users } from "@/internal/users";

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
const NONCE_TTL_SEC = 10 * 60;

const KEY_FORMAT = "der" as const;
const KEY_TYPE = "ed25519" as const;
const KEY_ENCODINGS = {
  PUBLIC_KEY: "spki",
  PRIVATE_KEY: "pkcs8",
} as const;

const SIGNATURE_HEADER = "x-request-signature";
const DEVELOPMENT_SIGNATURE_HEADER = "x-request-signature-development";

export class Authenticator extends Container.ServiceConstructable {
  #codec: Authenticator.Codec;
  #environment: Environment;
  #logger: Logger;
  #redis: Redis;
  #users: Users;
  #supervisors: Supervisors;

  constructor(codec: Authenticator.Codec, ...deps: [Environment, Logger, Redis, Users, Supervisors]) {
    super();

    this.#codec = codec;
    this.#environment = deps[0];
    this.#logger = deps[1].namespace("Authenticator");
    this.#redis = deps[2];
    this.#users = deps[3];
    this.#supervisors = deps[4];
  }

  async generateKeyPair() {
    return await new Promise<[Buffer, Buffer]>((resolve, reject) => {
      const options = {
        publicKeyEncoding: { type: KEY_ENCODINGS.PUBLIC_KEY, format: KEY_FORMAT },
        privateKeyEncoding: { type: KEY_ENCODINGS.PRIVATE_KEY, format: KEY_FORMAT },
      };

      generateKeyPair(KEY_TYPE, options, (error, publicKey, privateKey) => {
        if (error) {
          return reject(error);
        }

        return resolve([publicKey, privateKey]);
      });
    });
  }

  async authenticate(headers: Headers) {
    const raw = this.#parseHeader(headers);

    if (raw === null) {
      throw new Error("Missing signature header");
    }

    const [value, development] = raw;
    const buffer = this.#decodeBase64(value);

    if (development) {
      return this.#authenticateDevelopment(buffer);
    }

    return this.#authenticateProduction(buffer);
  }

  async #authenticateDevelopment(buffer: Buffer) {
    try {
      return this.#codec.decodeIdentity(buffer);
    } catch (error) {
      this.#logger.warn("Failed to decode development identity.", { err: error });

      throw new Error("Invalid development identity");
    }
  }

  async #authenticateProduction(buffer: Buffer) {
    let signature: Authenticator.Signature;

    try {
      signature = this.#codec.decodeSignature(buffer);
    } catch (error) {
      this.#logger.warn("Failed to decode request signature.", {
        err: error,
      });

      throw new Error("Invalid request signature");
    }

    const nonceHex = Buffer.from(signature.nonce).toString("hex");
    const unixSeconds = Math.floor(signature.timestamp.getTime() / 1000);

    await this.#checkTimestamp(signature.timestamp);
    await this.#checkNonce(nonceHex);

    const key = await this.#resolvePublicKey(signature.identity, nonceHex, unixSeconds);

    this.#verifySignature(key.publicKey, key.message, signature.signature);

    return signature.identity;
  }

  async #checkTimestamp(timestamp: Date) {
    const difference = Math.abs(Date.now() - timestamp.getTime());

    if (difference > TIMESTAMP_WINDOW_MS) {
      this.#logger.warn("Request timestamp outside allowed window.", {
        difference,
        window: TIMESTAMP_WINDOW_MS,
      });

      throw new Error("Request timestamp outside allowed window");
    }
  }

  async #checkNonce(nonceHex: string) {
    const key = `nonce:${nonceHex}`;

    try {
      const result = await this.#redis.client.set(key, "1", "EX", NONCE_TTL_SEC, "NX");

      if (result !== "OK") {
        this.#logger.warn("Nonce has already been used — possible replay attack.", {
          key,
        });

        throw new Error("Nonce already used");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Nonce")) {
        throw error;
      }

      this.#logger.error("Failed to persist nonce in Redis. Failing closed.", {
        err: error,
      });

      throw new Error("Nonce persistence failed");
    }
  }

  async #resolvePublicKey(identity: Authenticator.Identity, nonceHex: string, unixSeconds: number) {
    switch (identity.type) {
      case "manager": {
        const publicKey = this.#environment.get("MANAGER_PUBLIC_KEY");

        if (!publicKey) {
          throw new Error("Manager public key not configured");
        }

        return {
          message: `${nonceHex}:${unixSeconds}`,
          publicKey: Buffer.from(publicKey, "hex"),
        };
      }

      case "user": {
        const user = await this.#users.get(identity.id);

        if (!user) {
          this.#logger.warn("User not found for signature verification.", {
            userId: identity.id,
          });

          throw new Error("User not found");
        }

        return {
          message: `${nonceHex}:${unixSeconds}:${identity.id}`,
          publicKey: Buffer.from(user.publicKey),
        };
      }

      case "supervisor": {
        const supervisor = await this.#supervisors.get(identity.id);

        if (!supervisor) {
          this.#logger.warn("Supervisor not found for signature verification.", {
            supervisorId: identity.id,
          });

          throw new Error("Supervisor not found");
        }

        return {
          message: `${nonceHex}:${unixSeconds}:${identity.id}`,
          publicKey: Buffer.from(supervisor.publicKey),
        };
      }
    }
  }

  #parseHeader(headers: Headers) {
    const value = headers.get(SIGNATURE_HEADER);

    if (value !== null) {
      return [value, false] as const;
    }

    if (this.#environment.mode === Environment.Mode.Production) {
      return null;
    }

    const development = headers.get(DEVELOPMENT_SIGNATURE_HEADER);

    if (development !== null) {
      return [development, true] as const;
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

  #verifySignature(publicKey: Buffer, message: string, signature: Uint8Array) {
    let verified: boolean;

    try {
      const publicKeyObject = createPublicKey({
        key: publicKey,
        format: KEY_FORMAT,
        type: KEY_ENCODINGS.PUBLIC_KEY,
      });

      verified = verify(undefined, Buffer.from(message, "utf-8"), publicKeyObject, Buffer.from(signature));
    } catch (error) {
      this.#logger.error("Ed25519 signature verification threw an exception.", { err: error });

      throw new Error("Signature verification error");
    }

    if (!verified) {
      throw new Error("Signature verification failed");
    }
  }
}

export namespace Authenticator {
  export type Identity = { type: "user"; id: string } | { type: "manager" } | { type: "supervisor"; id: string };

  export type Signature = {
    nonce: Uint8Array;
    timestamp: Date;
    identity: Identity;
    signature: Uint8Array;
  };

  export type Codec = {
    decodeIdentity(buffer: Uint8Array): Identity;
    decodeSignature(buffer: Uint8Array): Signature;
  };
}
