import type { RPCConnection } from "@/rpc-connection";
import type { RPCMethod } from "@/rpc-method";

export class RPCHandler {
  register<T extends RPCMethod.Collection>(prefix: string, collection: T, implementation: RPCMethod.Collection.HandlersImplementation<T>) {}
}
