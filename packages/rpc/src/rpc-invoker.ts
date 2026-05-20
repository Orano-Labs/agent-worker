import type { RPCConnection } from "@/rpc-connection";
import type { RPCMessage } from "@/rpc-message";
import type { RPCMethod } from "@/rpc-method";

export class RPCInvoker<T extends RPCMethod.Collection> {
  #prefix: string;
  #collection: T;

  constructor(prefix: string, collection: T) {
    this.#prefix = prefix;
    this.#collection = collection;
  }

  implement(connection: RPCConnection) {
    const implementation = {} as RPCMethod.Collection.InvokersImplementation<T>;

    for (const key in this.#collection) {
      const invoker = (input: RPCMessage.Streamable<RPCMessage.Transferable>, options?: RPCMethod.Invoker.Options) => {
        return connection.invoke(`${this.#prefix}/${key}`, { data: input, metadata: options?.metadata || {} }, { signal: options?.signal });
      };

      implementation[key] = invoker as RPCMethod.Collection.InvokersImplementation<T>[keyof T];
    }

    return implementation;
  }
}
