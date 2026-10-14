import { default as assert } from "node:assert";
import type { ClientHttp2Stream, ServerHttp2Stream } from "node:http2";
import type { Socket } from "node:net";
import { default as pump } from "pump";
import { SocketPair } from "./socket-pair";

export class Bridge {
  #pairs: SocketPair;

  constructor() {
    this.#pairs = new SocketPair();
  }

  /**
   * Bridges an HTTP/2 stream into a plain `net.Socket`.
   *
   * The stream is spliced onto one side of a socket pair; the other side is
   * returned to the caller as an ordinary bidirectional socket endpoint.
   * Bytes flow in both directions, half-close (`end`) propagates in both
   * directions, and a close/error on either endpoint destroys both.
   */
  async pipe(stream: ServerHttp2Stream | ClientHttp2Stream): Promise<Socket> {
    assert(stream.readable, "Bridge cannot pipe a stream that is not readable");
    assert(stream.writable, "Bridge cannot pipe a stream that is not writable");

    // if ("headersSent" in stream) {
    //   assert(!stream.headersSent, "xxxxx");
    // }

    const pair = await this.#pairs.create();
    const socket = pair.client;

    pump(stream, socket);
    pump(socket, stream);

    stream.once("close", () => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    });

    socket.once("close", () => {
      if (!stream.destroyed) {
        stream.destroy();
      }
    });

    return pair.server;
  }
}
