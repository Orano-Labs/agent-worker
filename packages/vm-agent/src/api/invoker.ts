import { RPCInvoker } from "@aw/rpc";
import { FSProtocol } from "@/api/protocol/fs";

export namespace VMAgent {
  const fs = new RPCInvoker("vm-agent.fs", FSProtocol.methods);

  export const implement = (...args: Parameters<typeof fs.implement>) => {
    return {
      fs: fs.implement(...args),
    };
  };
}
