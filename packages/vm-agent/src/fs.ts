import { join } from "node:path";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { VMAgentFSService, type VMAgentFSServiceImplementation } from "@/protocol";
import { ROOT_DIR } from "./constants";
import { createInvalidArgumentError } from "./errors";

export const registerFSService = (router: ConnectRouter) => {
  const impl: VMAgentFSServiceImplementation<HandlerContext> = {};

  router.service(VMAgentFSService, {
    // list: impl.list,
    // read: impl.read,
    write: async (request, context) => {
      let writer: WritableStream | undefined;

      for await (const chunk of request) {
        if (!writer) {
          if (chunk.part.case !== "header") {
            throw createInvalidArgumentError("").error();
          }

          // const realpath = join(ROOT_DIR, chunk.part.value.path?.value)
        } else {
          if (chunk.part.case !== "chunk") {
            throw createInvalidArgumentError("").error();
          }
        }
      }

      return {};
    },
    // stats: impl.stats,
  });
};
