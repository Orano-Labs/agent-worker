import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { RPCConnection } from "@/rpc-connection";
import { RPCError } from "@/rpc-error";
import type { RPCMessage } from "@/rpc-message";
import type { RPCMethod } from "@/rpc-method";

export class RPCHandler {
  #implementations = new Map<string, RPCHandler.ImplementedMethod>();

  register<T extends RPCMethod.Collection>(prefix: string, collection: T, implementation: RPCMethod.Collection.HandlersImplementation<T>) {
    for (const key in collection) {
      const name = `${prefix}/${key}`;

      if (this.#implementations.has(name)) {
        throw new Error(`Method "${name}" already registered with prefix "${prefix}".`);
      }

      const method = collection[key];

      // @ts-expect-error
      this.#implementations.set(name, {
        ...method,
        ...{
          handler: implementation[key],
        },
      });
    }
  }

  defaultImplementation<T extends RPCMethod.Collection>(collection: T) {
    const implementation = {} as RPCMethod.Collection.HandlersImplementation<T>;

    for (const key in collection) {
      // @ts-expect-error
      implementation[key] = async () => {
        throw RPCError.createUnimplemented(`Method not implemented.`);
      };
    }

    return implementation;
  }

  createHandler() {
    const handler: RPCConnection.Handler = async (content, context) => {
      const method = this.#implementations.get(context.method);

      if (!method) {
        if (content.data instanceof ReadableStream) {
          content.data.cancel().catch(() => {});
        }

        throw RPCError.createUnimplemented(`Method '${context.method}' not implemented.`);
      }

      if (content.data instanceof ReadableStream) {
        if (method.type !== "client-stream" && method.type !== "bidirectional-stream") {
          content.data.cancel().catch(() => {});

          throw RPCError.createInvalidArgument(`Method '${context.method}' does not accept an input stream.`);
        }
      } else {
        if (method.type === "client-stream" || method.type === "bidirectional-stream") {
          throw RPCError.createInvalidArgument(`Method '${context.method}' requires an input stream.`);
        }
      }

      const metadata: Record<string, string> = {};
      const output = await Promise.resolve()
        .then(async () => {
          return method.handler(await this.#validateIncoming(content.data, method.incomingMessage), content.metadata, {
            id: context.id,
            signal: context.signal,
            metadata: content.metadata,
          });
        })
        .catch((error) => {
          if (content.data instanceof ReadableStream) {
            content.data.cancel(error).catch(() => {});
          }

          if (error instanceof RPCError) {
            throw error;
          }

          throw RPCError.createInternal(`An internal error occurred during method execution.`);
        });

      if (output instanceof ReadableStream) {
        if (method.type !== "server-stream" && method.type !== "bidirectional-stream") {
          output.cancel(new Error(`Method '${context.method}' unexpectedly returned a stream.`)).catch(() => {});

          throw RPCError.createInternal(`Method '${context.method}' unexpectedly returned a stream.`);
        }
      } else {
        if (method.type === "server-stream" || method.type === "bidirectional-stream") {
          throw RPCError.createInternal(`Method '${context.method}' failed to return a required output stream.`);
        }
      }

      return {
        data: await this.#validateOutgoing(output, method.outgoingMessage),
        metadata,
      };
    };

    return handler;
  }

  methods() {
    return [...this.#implementations.keys()];
  }

  get(method: string) {
    return this.#implementations.get(method);
  }

  deregister(prefix: string, collection: RPCMethod.Collection) {
    for (const key in collection) {
      this.#implementations.delete(`${prefix}/${key}`);
    }
  }

  #formatValidationIssues(issues: StandardSchemaV1.Issue[]) {
    return issues
      .map((issue) => {
        const path = issue.path
          ?.map((segment) => {
            const key = typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment;

            if (typeof key === "number") {
              return `[${key}]`;
            }

            return `.${String(key)}`;
          })
          .join("")
          .replace(/^\./, "");

        return ` > [${path || "&"}] ${issue.message}`;
      })
      .join("\n");
  }

  async #validateIncoming(data: RPCMessage.Streamable<RPCMessage.Transferable>, schema: RPCMethod.Schema) {
    if (data instanceof ReadableStream) {
      return this.#createValidatedIncomingStream(data, schema);
    } else {
      const result = await schema["~standard"].validate(data);

      if (result.issues) {
        throw RPCError.createInvalidArgument(`Invalid request message:\n${this.#formatValidationIssues([...result.issues])}`);
      }

      return result.value;
    }
  }

  async #validateOutgoing(data: RPCMessage.Streamable<RPCMessage.Transferable>, schema: RPCMethod.Schema) {
    if (data instanceof ReadableStream) {
      return this.#createValidatedOutgoingStream(data, schema);
    } else {
      const result = await schema["~standard"].validate(data);

      if (result.issues) {
        throw RPCError.createInternal(`Invalid response message:\n${this.#formatValidationIssues([...result.issues])}`);
      }

      return result.value;
    }
  }

  #createValidatedIncomingStream(stream: ReadableStream<RPCMessage.Transferable>, schema: RPCMethod.Schema) {
    return stream.pipeThrough(
      new TransformStream({
        transform: async (chunk, controller) => {
          const result = await schema["~standard"].validate(chunk);

          if (result.issues) {
            return controller.error(
              RPCError.createInvalidArgument(`Invalid chunk in request stream:\n${this.#formatValidationIssues([...result.issues])}`),
            );
          }

          controller.enqueue(result.value);
        },
      }),
    );
  }

  #createValidatedOutgoingStream(stream: ReadableStream<RPCMessage.Transferable>, schema: RPCMethod.Schema) {
    return stream.pipeThrough(
      new TransformStream({
        transform: async (chunk, controller) => {
          const result = await schema["~standard"].validate(chunk);

          if (result.issues) {
            return controller.error(
              RPCError.createInternal(`Invalid chunk in response stream:\n${this.#formatValidationIssues([...result.issues])}`),
            );
          }

          controller.enqueue(result.value);
        },
      }),
    );
  }
}

export namespace RPCHandler {
  export type ImplementedMethod = RPCMethod & {
    handler: RPCMethod.Handler.Any;
  };
}
