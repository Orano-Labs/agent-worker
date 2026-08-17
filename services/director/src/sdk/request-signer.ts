import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { SignatureIdentitySchema, type SignatureIdentityValid, SignatureSchema } from "@/generated/proto/api/v1/signature_pb";

export class RequestSigner {
  #identity: RequestSigner.Identity;
  #dev: boolean;

  constructor(identity: RequestSigner.Identity, dev = false) {
    this.#identity = identity;
    this.#dev = dev;
  }

  /**
   * Generates a production request signature for the `x-request-signature` header.
   *
   * 1. Generates a random 32-byte nonce for replay protection.
   * 2. Signs the payload string `{nonceHex}:{unixSeconds}[:{id}]` with the
   *    identity's Ed25519 private key.
   * 3. Serializes the {@link SignatureSchema} protobuf and returns it as a
   *    Base64-encoded string.
   */
  async generate() {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const unixSeconds = Math.floor(Date.now() / 1000);
    const timestamp = this.#timestampFromUnix(unixSeconds);

    const identity = this.#buildIdentity();
    const payloadString = this.#buildPayloadString(nonce, unixSeconds);
    const signature = await this.#sign(payloadString);

    const signatureMessage = create(SignatureSchema, {
      payload: {
        nonce,
        timestamp,
        identity,
      },
      signature,
    });

    return this.#toBase64(toBinary(SignatureSchema, signatureMessage));
  }

  /**
   * Generates a development request signature for the `x-request-signature-development`
   * header (no cryptographic signing).
   *
   * Simply serializes the {@link SignatureIdentitySchema} protobuf and returns it
   * as a Base64-encoded string.
   */
  async generateDev() {
    return this.#toBase64(toBinary(SignatureIdentitySchema, this.#buildIdentity()));
  }

  /** Writes the matching signature header based on the dev flag. */
  async apply(headers: Headers) {
    if (this.#dev) {
      headers.set("x-request-signature-development", await this.generateDev());
    } else {
      headers.set("x-request-signature", await this.generate());
    }

    return headers;
  }

  #buildIdentity() {
    const { type } = this.#identity;

    let result: SignatureIdentityValid;

    if (this.#identity.type === "manager") {
      result = {
        $typeName: "api.v1.SignatureIdentity",
        identity: {
          case: "manager",
          value: {
            $typeName: "api.v1.SignatureManagerIdentity",
          },
        },
      };
    } else if (type === "supervisor") {
      result = {
        $typeName: "api.v1.SignatureIdentity",
        identity: {
          case: "supervisor",
          value: {
            $typeName: "api.v1.SignatureSupervisorIdentity",
            id: this.#identity.id,
          },
        },
      };
    } else {
      result = {
        $typeName: "api.v1.SignatureIdentity",
        identity: {
          case: "user",
          value: {
            $typeName: "api.v1.SignatureUserIdentity",
            id: this.#identity.id,
          },
        },
      };
    }

    return result;
  }

  /**
   * Builds the payload string signed with Ed25519.
   *
   * Format:
   *   Manager:    `{nonceHex}:{unixSeconds}`
   *   User/Worker:`{nonceHex}:{unixSeconds}:{id}`
   */
  #buildPayloadString(nonce: Uint8Array, unixSeconds: number) {
    const nonceHex = this.#toHex(nonce);

    if (this.#identity.type === "manager") {
      return `${nonceHex}:${unixSeconds}`;
    }

    return `${nonceHex}:${unixSeconds}:${this.#identity.id}`;
  }

  /**
   * Signs a payload string with the identity's Ed25519 private key.
   *
   * The private key is a 48-byte PKCS#8 DER key (hex-encoded), as returned by
   * {@link Key.generateED25519}.
   */
  async #sign(payload: string) {
    const pkcs8 = this.#hexToUint8Array(this.#identity.privateKey);

    const privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array(pkcs8), { name: "Ed25519" }, false, ["sign"]);

    const payloadBytes = new TextEncoder().encode(payload);
    const signatureBuffer = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, payloadBytes);

    return new Uint8Array(signatureBuffer);
  }

  #timestampFromUnix(unixSeconds: number) {
    return timestampFromMs(unixSeconds * 1000);
  }

  #toHex(source: Uint8Array) {
    return source.reduce((str, byte) => str + byte.toString(16).padStart(2, "0"), "");
  }

  #toBase64(source: Uint8Array) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(source).toString("base64");
    }

    return btoa(String.fromCharCode(...source));
  }

  #hexToUint8Array(source: string) {
    return new Uint8Array(source.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
  }
}

export namespace RequestSigner {
  export type Identity =
    | {
        type: "user" | "supervisor";
        id: string;
        privateKey: string;
      }
    | {
        type: "manager";
        privateKey: string;
      };
}
