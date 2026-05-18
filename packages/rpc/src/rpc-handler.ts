import type { RPCConnection } from "@/rpc-connection";
import { RPCError } from "@/rpc-error";
import { RPCMethod } from "@/rpc-method";

export class RPCHandler {
  #implementations = new Map<
    string,
    RPCMethod & {
      handler: RPCMethod.Handler.Any;
    }
  >();

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
      implementation[key] = () => {
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
        if (method.type !== RPCMethod.Type.ClientStream && method.type !== RPCMethod.Type.BidiStream) {
          content.data.cancel().catch(() => {});

          throw RPCError.createInvalidArgument(`Method '${context.method}' does not accept an input stream.`);
        }
      } else {
        if (method.type === RPCMethod.Type.ClientStream || method.type === RPCMethod.Type.BidiStream) {
          throw RPCError.createInvalidArgument(`Method '${context.method}' requires an input stream.`);
        }
      }

      const metadata: Record<string, string> = {};
      const output = await Promise.resolve()
        .then(async () => {
          return method.handler(content.data, content.metadata, {
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
        if (method.type !== RPCMethod.Type.ClientStream && method.type !== RPCMethod.Type.BidiStream) {
          output.cancel(new Error(`Method '${context.method}' unexpectedly returned a stream.`)).catch(() => {});

          throw RPCError.createInternal(`Method '${context.method}' unexpectedly returned a stream.`);
        }
      } else {
        if (method.type === RPCMethod.Type.ClientStream || method.type === RPCMethod.Type.BidiStream) {
          throw RPCError.createInternal(`Method '${context.method}' failed to return a required output stream.`);
        }
      }

      return {
        data: output,
        metadata,
      };
    };

    return handler;
  }
}
