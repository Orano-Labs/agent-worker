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
} from "@bufbuild/protobuf";
import { type CallOptions, createClient, type Transport } from "@connectrpc/connect";
import { ProjectService } from "@/generated/proto/api/v1/project_pb";
import { SupervisorService } from "@/generated/proto/api/v1/supervisor_pb";
import { SupervisorPortalService } from "@/generated/proto/api/v1/supervisor-portal_pb";
import { TemplateService } from "@/generated/proto/api/v1/template_pb";
import { UserService } from "@/generated/proto/api/v1/user_pb";
import { RequestSigner } from "@/sdk/request-signer";

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
  #signer: RequestSigner;

  constructor(transport: Transport, identity: Client.Identity, dev = false) {
    this.#signer = new RequestSigner(identity, dev);

    this.#transport = {
      unary: async (method, signal, timeoutMs, header, input, contextValues) => {
        const headers = new Headers(header);

        await this.#signer.apply(headers);

        return transport.unary(method, signal, timeoutMs, headers, input, contextValues);
      },
      stream: async (method, signal, timeoutMs, header, input, contextValues) => {
        const headers = new Headers(header);

        await this.#signer.apply(headers);

        return transport.stream(method, signal, timeoutMs, headers, input, contextValues);
      },
    };
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
  export type Identity = RequestSigner.Identity;
}

export * as ProjectPB from "@/generated/proto/api/v1/project_pb";
export * as SignaturePB from "@/generated/proto/api/v1/signature_pb";
export * as SupervisorPB from "@/generated/proto/api/v1/supervisor_pb";
export * as SupervisorPortalPB from "@/generated/proto/api/v1/supervisor-portal_pb";
export * as TemplatePB from "@/generated/proto/api/v1/template_pb";
export * as UserPB from "@/generated/proto/api/v1/user_pb";
