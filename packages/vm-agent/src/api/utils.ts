import type { RPCConnection, RPCMessage } from "@aw/rpc";
import { decode, encode } from "msgpackr";

export namespace APIUtils {
  export const encoder: RPCConnection.Encoder = {
    encode: (data: RPCMessage) => encode(data),
    decode: (data: Uint8Array) => decode(data) as RPCMessage,
  };
}
