import { debug } from "debug";

export namespace Debugger {
  export const connection = debug("rpc:connection");
  export const handler = debug("rpc:handler");
  export const incomingStreams = debug("rpc:incoming-streams");
  export const outgoingStreams = debug("rpc:outgoing-streams");
}
