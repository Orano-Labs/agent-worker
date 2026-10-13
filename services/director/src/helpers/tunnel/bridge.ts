import { default as assert } from "node:assert";
import type { ClientHttp2Stream, ServerHttp2Stream } from "node:http2";
import { SocketPair } from "./socket-pair";

export class Bridge {
  #pairs: SocketPair;

  constructor() {
    this.#pairs = new SocketPair();
  }

  async pipe(stream: ServerHttp2Stream | ClientHttp2Stream) {
    assert(stream.readable, "Bridge cannot pipe a server stream that is not readable");
    assert(stream.writable, "Bridge cannot pipe a server stream that is not writable");

    const pair = await this.#pairs.create();

    stream.pipe(pair.client, { end: false });
    pair.client.pipe(stream, { end: false });

    // pair.client.on("end", () => {
    //   if (!stream.destroyed && stream.writable) {
    //     stream.end();
    //   }
    // });
    // stream.on("end", () => {
    //   if (!socket.destroyed && socket.writable) {
    //     socket.end();
    //   }
    // });
  }
}
