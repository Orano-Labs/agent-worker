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
import { type CallOptions, createClient, type Transport } from "@connectrpc/connect";
import * as ProjectPB from "@/generated/proto/api/v1/project_pb";
import { ProjectService } from "@/generated/proto/api/v1/project_pb";
import * as SignaturePB from "@/generated/proto/api/v1/signature_pb";
import { SignatureIdentitySchema, type SignatureIdentityValid } from "@/generated/proto/api/v1/signature_pb";
import * as SupervisorPB from "@/generated/proto/api/v1/supervisor_pb";
import { SupervisorService } from "@/generated/proto/api/v1/supervisor_pb";
import * as SupervisorPortalPB from "@/generated/proto/api/v1/supervisor-portal_pb";
import { SupervisorPortalService } from "@/generated/proto/api/v1/supervisor-portal_pb";
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

  async #generateRequestSignature() {
    // const nonce = crypto.getRandomValues(new Uint8Array(32));
    // const timestamp = Math.floor(Date.now() / 1000);
    //
    // const pkcs8Header = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
    // const pkcs8Bytes = new Uint8Array(pkcs8Header.length + 32);
    //
    // pkcs8Bytes.set(pkcs8Header);
    // pkcs8Bytes.set(this.#hexToUint8Array(this.#identity.privateKey), pkcs8Header.length);
    //
    // const payloadString = `${this.#hexFromUint8Array(nonce)}:${timestamp}${this.#identity.type === "manager" ? "" : `:${this.#identity.id}`}`;
    // const payloadBytes = new TextEncoder().encode(payloadString);
    //
    // const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8Bytes, {
    //   name: "Ed25519",
    //   namedCurve: "Ed25519"
    // }, false, ["sign"]);
    // const signatureBuffer = await crypto.subtle.sign({name: "Ed25519"}, privateKey, payloadBytes);

    return "";
  }

  async #generateRequestSignatureDev() {
    let identity: SignatureIdentityValid;

    if (this.#identity.type === "manager") {
      identity = {
        $typeName: "api.v1.SignatureIdentity",
        identity: {
          case: "manager",
          value: {
            $typeName: "api.v1.SignatureManagerIdentity",
          },
        },
      };
    } else if (this.#identity.type === "supervisor") {
      identity = {
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
      identity = {
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

    return this.#hexFromUint8Array(toBinary(SignatureIdentitySchema, identity));
  }

  #hexFromUint8Array(source: Uint8Array) {
    return source.reduce((str, byte) => str + byte.toString(16).padStart(2, "0"), "");
  }

  #hexToUint8Array(source: string) {
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
}
