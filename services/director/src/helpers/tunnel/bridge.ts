import { default as assert } from "node:assert";
import type { ClientHttp2Stream, ServerHttp2Stream } from "node:http2";
import type { Socket } from "node:net";

export class Bridge {
  pipeClientStream(socket: Socket, stream: ClientHttp2Stream) {
    assert(socket.readable, "Bridge cannot pipe a client stream into a socket that is not readable");
    assert(socket.writable, "Bridge cannot pipe a client stream into a socket that is not writable");
    assert(stream.readable, "Bridge cannot pipe a client stream that is not readable");
    assert(stream.writable, "Bridge cannot pipe a client stream that is not writable");

    assert(!socket.allowHalfOpen, "Bridge requires a socket with allowHalfOpen disabled");

    socket.pipe(stream, { end: false });
    stream.pipe(socket, { end: false });

    socket.on("end", () => {
      if (!stream.destroyed && stream.writable) {
        stream.end();
      }
    });
    stream.on("end", () => {
      if (!socket.destroyed && socket.writable) {
        socket.end();
      }
    });

    const destroyBoth = (result: Error | boolean) => {
      if (!socket.destroyed) socket.destroy(result instanceof Error ? result : undefined);
      if (!stream.destroyed) stream.destroy(result instanceof Error ? result : undefined);

      socket.off("close", destroyBoth);
      socket.off("error", destroyBoth);
      stream.off("close", destroyBoth);
      stream.off("error", destroyBoth);
    };

    socket.once("close", destroyBoth);
    stream.once("close", destroyBoth);
    socket.once("error", destroyBoth);
    stream.once("error", destroyBoth);
  }

  pipeServerStream(socket: Socket, stream: ServerHttp2Stream) {
    assert(socket.readable, "Bridge cannot pipe a server stream into a socket that is not readable");
    assert(socket.writable, "Bridge cannot pipe a server stream into a socket that is not writable");
    assert(stream.readable, "Bridge cannot pipe a server stream that is not readable");
    assert(stream.writable, "Bridge cannot pipe a server stream that is not writable");

    assert(!socket.allowHalfOpen, "Bridge requires a socket with allowHalfOpen disabled");

    stream.pipe(socket, { end: false });
    socket.pipe(stream, { end: false });

    socket.on("end", () => {
      if (!stream.destroyed && stream.writable) {
        stream.end();
      }
    });
    stream.on("end", () => {
      if (!socket.destroyed && socket.writable) {
        socket.end();
      }
    });

    const destroyBoth = (result: Error | boolean) => {
      if (!socket.destroyed) socket.destroy(result instanceof Error ? result : undefined);
      if (!stream.destroyed) stream.destroy(result instanceof Error ? result : undefined);

      socket.off("close", destroyBoth);
      socket.off("error", destroyBoth);
      stream.off("close", destroyBoth);
      stream.off("error", destroyBoth);
    };

    socket.once("close", destroyBoth);
    stream.once("close", destroyBoth);
    socket.once("error", destroyBoth);
    stream.once("error", destroyBoth);
  }
}
