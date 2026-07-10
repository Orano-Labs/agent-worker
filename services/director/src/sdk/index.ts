import {
  create,
  type DescMessage,
  type DescMethodBiDiStreaming,
  type DescMethodClientStreaming,
  type DescMethodServerStreaming,
  type DescMethodUnary,
  type DescService,
  type MessageInitShape,
  type MessageValidType,
  toBinary,
} from "@bufbuild/protobuf";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import { type CallOptions, createClient, type Transport } from "@connectrpc/connect";
import * as ProjectPB from "@/generated/proto/api/v1/project_pb";
import { ProjectService } from "@/generated/proto/api/v1/project_pb";
import * as SignaturePB from "@/generated/proto/api/v1/signature_pb";
import { SignatureIdentitySchema, type SignatureIdentityValid, SignatureSchema } from "@/generated/proto/api/v1/signature_pb";
import * as SupervisorPB from "@/generated/proto/api/v1/supervisor_pb";
import { SupervisorService } from "@/generated/proto/api/v1/supervisor_pb";
import * as SupervisorPortalPB from "@/generated/proto/api/v1/supervisor-portal_pb";
import { SupervisorPortalService } from "@/generated/proto/api/v1/supervisor-portal_pb";
import * as TemplatePB from "@/generated/proto/api/v1/template_pb";
import { TemplateService } from "@/generated/proto/api/v1/template_pb";
import * as UserPB from "@/generated/proto/api/v1/user_pb";
import { UserService } from "@/generated/proto/api/v1/user_pb";

type InferServiceValid<T extends DescService> = {
  [P in keyof T["method"]]: T["method"][P] extends DescMethodUnary<infer I, infer O>
    ? (request: MessageValidType<I>, options?: CallOptions) => Promise<MessageValidType<O>>
    : T["method"][P] extends DescMethodServerStreaming<infer I, infer O>
      ? (request: MessageValidType<I>, options?: CallOptions) => AsyncIterable<MessageValidType<O>>
      : T["method"][P] extends DescMethodClientStreaming<infer I, infer O>
        ? (request: AsyncIterable<MessageValidType<I>>, options?: CallOptions) => Promise<MessageValidType<O>>
        : T["method"][P] extends DescMethodBiDiStreaming<infer I, infer O>
          ? (request: AsyncIterable<MessageValidType<I>>, options?: CallOptions) => AsyncIterable<MessageValidType<O>>
          : never;
};

const PKCS8_ED25519_HEADER = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export class Client {
  #transport: Transport;
  #identity: Client.Identity;
  #dev: boolean;

  constructor(transport: Transport, identity: Client.Identity, dev = false) {
    this.#transport = {
      unary: async (method, signal, timeoutMs, header, input, contextValues) => {
        const headers = new Headers(header);

        if (this.#dev) {
          headers.set("x-request-signature-development", await this.#generateRequestSignatureDev());
        } else {
          headers.set("x-request-signature", await this.#generateRequestSignature());
        }

        return transport.unary(method, signal, timeoutMs, headers, input, contextValues);
      },
      stream: async (method, signal, timeoutMs, header, input, contextValues) => {
        const headers = new Headers(header);

        if (this.#dev) {
          headers.set("x-request-signature-development", await this.#generateRequestSignatureDev());
        } else {
          headers.set("x-request-signature", await this.#generateRequestSignature());
        }

        return transport.stream(method, signal, timeoutMs, headers, input, contextValues);
      },
    };
    this.#identity = identity;
    this.#dev = dev;
  }

  /**
   * Generate a production request signature.
   *
   * 1. Creates a random 32-byte nonce for replay protection.
   * 2. Signs the payload string `{nonceHex}:{unixSeconds}[:{id}]` with the
   *    identity's Ed25519 private key.
   * 3. Serializes the {@link SignaturePB.Signature} protobuf and returns it
   *    as a Base64-encoded string for the `x-request-signature` header.
   */
  async #generateRequestSignature() {
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

    return Client.toBase64(toBinary(SignatureSchema, signatureMessage));
  }

  /**
   * Generate a development request signature (no cryptographic signing).
   *
   * Simply serializes the {@link SignatureIdentity} and returns it as Base64
   * for the `x-request-signature-development` header.  The server will skip
   * signature verification in non-production environments.
   */
  async #generateRequestSignatureDev() {
    const identity = this.#buildIdentity();

    return Client.toBase64(toBinary(SignatureIdentitySchema, identity));
  }

  /**
   * Build the {@link SignatureIdentity} protobuf from the client's identity.
   */
  #buildIdentity(): SignatureIdentityValid {
    const { type } = this.#identity;

    if (type === "manager") {
      return create(SignatureIdentitySchema, {
        identity: {
          case: "manager",
          value: {
            $typeName: "api.v1.SignatureManagerIdentity",
          },
        },
      }) as SignatureIdentityValid;
    }

    if (type === "supervisor") {
      return create(SignatureIdentitySchema, {
        identity: {
          case: "supervisor",
          value: {
            $typeName: "api.v1.SignatureSupervisorIdentity",
            id: this.#identity.id,
          },
        },
      }) as SignatureIdentityValid;
    }

    return create(SignatureIdentitySchema, {
      identity: {
        case: "user",
        value: {
          $typeName: "api.v1.SignatureUserIdentity",
          id: this.#identity.id,
        },
      },
    }) as SignatureIdentityValid;
  }

  /**
   * Build the payload string for Ed25519 signing.
   *
   * Format:
   *   Manager:    `{nonceHex}:{unixSeconds}`
   *   User/Worker:`{nonceHex}:{unixSeconds}:{id}`
   */
  #buildPayloadString(nonce: Uint8Array, unixSeconds: number) {
    const nonceHex = Client.toHex(nonce);

    if (this.#identity.type === "manager") {
      return `${nonceHex}:${unixSeconds}`;
    }

    return `${nonceHex}:${unixSeconds}:${this.#identity.id}`;
  }

  /**
   * Sign a payload string with the identity's Ed25519 private key.
   *
   * The private key is stored as a hex-encoded 32-byte seed.  We reconstruct
   * the PKCS#8 DER envelope around it so the Web Crypto API can import it.
   */
  async #sign(payload: string) {
    const seed = Client.hexToUint8Array(this.#identity.privateKey);
    const pkcs8 = new Uint8Array(PKCS8_ED25519_HEADER.length + seed.length);

    pkcs8.set(PKCS8_ED25519_HEADER);
    pkcs8.set(seed, PKCS8_ED25519_HEADER.length);

    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);

    const payloadBytes = new TextEncoder().encode(payload);
    const signatureBuffer = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, payloadBytes);

    return new Uint8Array(signatureBuffer);
  }

  #timestampFromUnix(unixSeconds: number): Timestamp {
    return {
      $typeName: "google.protobuf.Timestamp",
      seconds: BigInt(unixSeconds),
      nanos: 0,
    };
  }

  static toHex(source: Uint8Array) {
    return source.reduce((str, byte) => str + byte.toString(16).padStart(2, "0"), "");
  }

  static toBase64(source: Uint8Array) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(source).toString("base64");
    }

    return btoa(String.fromCharCode(...source));
  }

  static hexToUint8Array(source: string) {
    return new Uint8Array(source.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
  }

  createUserService() {
    return createClient(UserService, this.#transport) as InferServiceValid<typeof UserService>;
  }

  createSupervisorService() {
    return createClient(SupervisorService, this.#transport) as InferServiceValid<typeof SupervisorService>;
  }

  createProjectService() {
    return createClient(ProjectService, this.#transport) as InferServiceValid<typeof ProjectService>;
  }

  createSupervisorPortalService() {
    return createClient(SupervisorPortalService, this.#transport) as InferServiceValid<typeof SupervisorPortalService>;
  }

  createTemplateService() {
    return createClient(TemplateService, this.#transport) as InferServiceValid<typeof TemplateService>;
  }

  static createMessageValid<T extends DescMessage>(desc: T, message: Omit<MessageValidType<T>, "$typeName" | "$unknown">) {
    return create(desc, message as unknown as MessageInitShape<T>) as MessageValidType<T>;
  }
}

export namespace Client {
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

  export const User = UserPB;
  export const Project = ProjectPB;
  export const Supervisor = SupervisorPB;
  export const SupervisorPortal = SupervisorPortalPB;
  export const Signature = SignaturePB;
  export const Template = TemplatePB;
}
