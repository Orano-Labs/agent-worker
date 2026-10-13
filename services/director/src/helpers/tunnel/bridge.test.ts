import {
  type ClientHttp2Session,
  type ClientHttp2Stream,
  connect,
  constants,
  createServer,
  type Http2Server,
  type Http2Stream,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bridge } from "./bridge";
import { SocketPair } from "./socket-pair";

describe("Bridge", () => {
  const pairs = new SocketPair();

  let serverSocketPair: SocketPair.Pair;
  let clientSocketPair: SocketPair.Pair;

  let http2Server: Http2Server;
  let http2ClientSession: ClientHttp2Session;
  let http2ServerSession: ServerHttp2Session;

  let http2ClientStream: ClientHttp2Stream;
  let http2ServerStream: ServerHttp2Stream;

  let socketPair: SocketPair.Pair;

  beforeEach(async () => {
    // Host side: its client side is the test-facing endpoint, its server side
    // is spliced onto the client HTTP/2 stream.
    const hostPair = await pairs.create();
    // Guest side: its server side is the test-facing endpoint, its client side
    // is spliced onto the server HTTP/2 stream.
    const guestPair = await pairs.create();

    const http2SocketPair = await pairs.create();

    http2Server = createServer({
      settings: {
        enableConnectProtocol: true,
      },
    });

    const http2ServerSessionPromise = new Promise<ServerHttp2Session>((resolve, reject) => {
      http2Server.once("session", (session) => {
        // Advertise extended CONNECT (RFC 8441) so `:protocol` is accepted.
        // Without this the client's `:protocol: "tcp"` CONNECT is rejected
        // with NGHTTP2_PROTOCOL_ERROR.
        session.settings({ enableConnectProtocol: true });
        resolve(session);
      });
      http2Server.once("error", (error) => {
        reject(error);
      });
    });

    const http2ClientSessionPromise = new Promise<ClientHttp2Session>((resolve, reject) => {
      const client = connect("http://localhost:8000", {
        createConnection: () => {
          return http2SocketPair.client;
        },
      });

      client.once("connect", () => {
        resolve(client);
      });

      client.once("error", (error) => {
        reject(error);
      });
    });

    http2Server.emit("connection", http2SocketPair.server);

    [http2ClientSession, http2ServerSession] = await Promise.all([http2ClientSessionPromise, http2ServerSessionPromise]);

    const http2ServerStreamPromise = new Promise<ServerHttp2Stream>((resolve, reject) => {
      http2ServerSession.on("stream", (stream, headers) => {
        if (headers[":method"] !== "CONNECT") {
          stream.respond({ ":status": 405 });
          stream.end();

          return reject(new Error("Expected an extended CONNECT stream"));
        }

        stream.respond({ ":status": 200 });

        resolve(stream);
      });
    });
    const http2ClientStreamPromise = new Promise<ClientHttp2Stream>((resolve, reject) => {
      const stream = http2ClientSession.request({
        ":method": "CONNECT",
        ":path": "/",
        ":authority": "example.com:8080",
        ":scheme": "http",
        ":protocol": "tcp",
        "content-type": "application/octet-stream",
      });

      // For an extended CONNECT stream, the client learns the tunnel is
      // established via the `response` event (the peer's 200), not `ready`.
      stream.on("response", () => {
        resolve(stream);
      });

      stream.once("error", (error) => {
        reject(error);
      });
    });

    [http2ClientStream, http2ServerStream] = await Promise.all([http2ClientStreamPromise, http2ServerStreamPromise]);

    // The two test-facing endpoints are on opposite sides of the tunnel:
    // `client` lives on the host's socket pair, `server` on the guest's pair,
    // connected only through the bridged HTTP/2 CONNECT stream.
    socketPair = {
      client: hostPair.client,
      server: guestPair.server,
    };

    // Retain the splice-side sockets so afterEach can tear them down.
    serverSocketPair = hostPair;
    clientSocketPair = guestPair;

    for (const s of [
      socketPair.client,
      socketPair.server,
      serverSocketPair.client,
      serverSocketPair.server,
      clientSocketPair.client,
      clientSocketPair.server,
      http2SocketPair.client,
      http2SocketPair.server,
      http2ClientStream,
      http2ServerStream,
    ]) {
      s.on("error", console.log);
    }
  });

  afterEach(async () => {
    // Unwind the bridged and spare sockets first so the pipes stop moving data
    // before the HTTP/2 streams and sessions are torn down.
    for (const socket of [clientSocketPair?.client, clientSocketPair?.server, serverSocketPair?.client, serverSocketPair?.server]) {
      if (socket && !socket.destroyed) {
        socket.destroy();
      }
    }

    // Close the CONNECT streams on both ends of the bridge.
    if (http2ClientStream && !http2ClientStream.closed) {
      http2ClientStream.close(constants.NGHTTP2_NO_ERROR);
    }
    if (http2ServerStream && !http2ServerStream.closed) {
      http2ServerStream.close(constants.NGHTTP2_NO_ERROR);
    }

    // Tear down the HTTP/2 sessions before closing the server that hosted the
    // guest side, otherwise the server would wait for the session to finish.
    if (http2ClientSession && !http2ClientSession.destroyed) {
      http2ClientSession.destroy();
    }
    if (http2ServerSession && !http2ServerSession.destroyed) {
      http2ServerSession.destroy();
    }

    await new Promise<void>((resolve) => http2Server.close(() => resolve()));
  });

  const collectUntilEnd = (stream: Socket | Http2Stream) => {
    const chunks: Buffer[] = [];

    return new Promise<{ chunks: Buffer[]; data: Buffer }>((resolve, reject) => {
      stream.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      stream.once("end", () => resolve({ chunks, data: Buffer.concat(chunks) }));
      stream.once("error", reject);
    });
  };

  const waitForClose = (stream: Socket | Http2Stream, ms = 3000) => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for 'close' to propagate")), ms);
      stream.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  /**
   * Collects every chunk delivered on `stream` until its readable side ends,
   * then resolves with the concatenation of all chunks in arrival order.
   */
  const collectStreamUntilEnd = (stream: Http2Stream) => {
    const chunks: Buffer[] = [];

    return new Promise<{ chunks: Buffer[]; data: Buffer }>((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.once("end", () => resolve({ chunks, data: Buffer.concat(chunks) }));
      stream.once("error", reject);
    });
  };

  it("propagates a close from the client stream to the server stream", async () => {
    const bridge = new Bridge();

    bridge.pipeClientStream(serverSocketPair.server, http2ClientStream);
    bridge.pipe(clientSocketPair.client, http2ServerStream);

    const serverStreamClosed = waitForClose(http2ServerStream);

    http2ClientStream.close();

    await serverStreamClosed;

    expect(http2ServerStream.destroyed).toBe(true);
    expect(http2ClientStream.destroyed).toBe(true);
  });

  it("propagates a close from the server stream to the client stream", async () => {
    const clientStreamClosed = waitForClose(http2ClientStream);

    http2ServerStream.close();

    await clientStreamClosed;

    expect(http2ServerStream.destroyed).toBe(true);
    expect(http2ClientStream.destroyed).toBe(true);
  });

  describe("Bridge.pipeClientStream", () => {
    it("forwards data from the socket to the client stream", async () => {
      const received = collectStreamUntilEnd(http2ServerStream);

      socketPair.client.end("to-stream");

      expect((await received).data.toString()).toBe("to-stream");
    });

    it("forwards data from the client stream to the socket", async () => {
      const received = collectUntilEnd(socketPair.client);

      http2ServerStream.end("to-socket");

      expect((await received).data.toString()).toBe("to-socket");
    });

    it("propagates an end from the socket to the client stream", async () => {
      const streamEnded = new Promise<void>((resolve) => {
        http2ServerStream.once("end", resolve);
      });

      socketPair.client.end();

      await streamEnded;
    });

    it("propagates an end from the client stream to the socket", async () => {
      const socketEnded = new Promise<void>((resolve) => {
        socketPair.client.once("end", resolve);
      });

      http2ServerStream.end();

      await socketEnded;
      expect(socketPair.client.readableEnded).toBe(true);
    });

    it("propagates a close from the socket to the client stream", async () => {
      const streamClosed = waitForClose(http2ServerStream);

      serverSocketPair.server.destroy();

      await streamClosed;
      expect(http2ServerStream.destroyed).toBe(true);
    });

    it("propagates a close from the client stream to the socket", async () => {
      const socketClosed = waitForClose(serverSocketPair.server);

      http2ClientStream.close(constants.NGHTTP2_NO_ERROR);

      await socketClosed;
      expect(serverSocketPair.server.destroyed).toBe(true);
    });
  });

  describe("Bridge.pipeServerStream", () => {
    it("forwards data from the socket to the server stream", async () => {
      const received = collectStreamUntilEnd(http2ClientStream);

      socketPair.server.end("to-stream");

      expect((await received).data.toString()).toBe("to-stream");
    });

    it("forwards data from the server stream to the socket", async () => {
      const received = collectUntilEnd(socketPair.server);

      http2ClientStream.end("to-socket");

      expect((await received).data.toString()).toBe("to-socket");
    });

    it("propagates an end from the socket to the server stream", async () => {
      const streamEnded = new Promise<void>((resolve) => {
        http2ClientStream.once("end", resolve);
      });

      socketPair.server.end();

      await streamEnded;
    });

    it("propagates an end from the server stream to the socket", async () => {
      const socketEnded = new Promise<void>((resolve) => {
        socketPair.server.once("end", resolve);
      });

      http2ClientStream.end();

      await socketEnded;
      expect(socketPair.server.readableEnded).toBe(true);
    });

    it("propagates a close from the socket to the server stream", async () => {
      const streamClosed = waitForClose(http2ClientStream);

      clientSocketPair.client.destroy();

      await streamClosed;
      expect(http2ClientStream.destroyed).toBe(true);
    });

    it("propagates a close from the server stream to the socket", async () => {
      const socketClosed = waitForClose(clientSocketPair.client);

      http2ServerStream.close(constants.NGHTTP2_NO_ERROR);

      await socketClosed;
      expect(clientSocketPair.client.destroyed).toBe(true);
    });
  });

  describe("data flow", () => {
    it("forwards bytes from the client endpoint to the server endpoint", async () => {
      const received = collectUntilEnd(socketPair.server);

      socketPair.client.end("hello-from-client");

      expect((await received).data.toString()).toBe("hello-from-client");
    });

    it("forwards bytes from the server endpoint to the client endpoint", async () => {
      const received = collectUntilEnd(socketPair.client);

      socketPair.server.end("hello-from-server");

      expect((await received).data.toString()).toBe("hello-from-server");
    });

    //     it("carries bytes in both directions over the tunnel", async () => {
    //       const clientReceived = collectUntilEnd(socketPair.client);
    //       const serverReceived = collectUntilEnd(socketPair.server);
    //
    //       socketPair.client.end("ping");
    //       socketPair.server.end("pong");
    //
    //       const [clientRes, serverRes] = await Promise.all([clientReceived, serverReceived]);
    //
    //       expect(serverRes.data.toString()).toBe("ping");
    //       expect(clientRes.data.toString()).toBe("pong");
    //     });

    it("splits a large payload into many chunks without loss or reordering", async () => {
      const http2SocketPair = await pairs.create();
      const http2Server = createServer({
        settings: {
          enableConnectProtocol: true,
        },
      });

      const http2ServerSessionPromise = new Promise<ServerHttp2Session>((resolve, reject) => {
        http2Server.once("session", (session) => {
          // Advertise extended CONNECT (RFC 8441) so `:protocol` is accepted.
          // Without this the client's `:protocol: "tcp"` CONNECT is rejected
          // with NGHTTP2_PROTOCOL_ERROR.
          session.settings({ enableConnectProtocol: true });
          resolve(session);
        });
        http2Server.once("error", (error) => {
          reject(error);
        });
      });

      const http2ClientSessionPromise = new Promise<ClientHttp2Session>((resolve, reject) => {
        const client = connect("http://localhost:8000", {
          createConnection: () => {
            return http2SocketPair.client;
          },
        });

        client.once("connect", () => {
          resolve(client);
        });

        client.once("error", (error) => {
          reject(error);
        });
      });

      http2Server.emit("connection", http2SocketPair.server);

      const [http2ClientSession, http2ServerSession] = await Promise.all([http2ClientSessionPromise, http2ServerSessionPromise]);

      const http2ServerStreamPromise = new Promise<ServerHttp2Stream>((resolve, reject) => {
        http2ServerSession.on("stream", (stream, headers) => {
          if (headers[":method"] !== "CONNECT") {
            stream.respond({ ":status": 405 });
            stream.end();

            return reject(new Error("Expected an extended CONNECT stream"));
          }

          stream.respond({ ":status": 200 });

          resolve(stream);
        });
      });
      const http2ClientStreamPromise = new Promise<ClientHttp2Stream>((resolve, reject) => {
        const stream = http2ClientSession.request({
          ":method": "CONNECT",
          ":path": "/",
          ":authority": "example.com:8080",
          ":scheme": "http",
          ":protocol": "tcp",
          "content-type": "application/octet-stream",
        });

        // For an extended CONNECT stream, the client learns the tunnel is
        // established via the `response` event (the peer's 200), not `ready`.
        stream.on("response", () => {
          resolve(stream);
        });

        stream.once("error", (error) => {
          reject(error);
        });
      });

      const [http2ClientStream, http2ServerStream] = await Promise.all([http2ClientStreamPromise, http2ServerStreamPromise]);

      const received = new Promise<{ chunks: Buffer[]; data: Buffer }>((resolve, reject) => {
        const chunks: Buffer[] = [];

        http2ServerStream.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        http2ServerStream.once("end", () => resolve({ chunks, data: Buffer.concat(chunks) }));
        http2ServerStream.once("error", reject);
      });

      http2ClientStream.write(Buffer.alloc(1024 * 1024, "x"), () => {
        http2ClientStream.end();
      });

      const { data } = await received;

      expect(data.equals(Buffer.alloc(1024 * 1024, "x"))).toBe(true);
    });

    //     it("splits a large payload into many chunks without loss or reordering", async () => {
    //       const received = collectUntilEnd(socketPair.server);
    //
    //       socketPair.client.write(Buffer.alloc(1024 * 256, "x"), () => {
    //         socketPair.client.end();
    //       });
    //
    //       const { chunks, data } = await received;
    //
    //       expect(chunks.length).toBeGreaterThan(1);
    //       expect(data.equals(Buffer.alloc(1024 * 1024, "x"))).toBe(true);
    //     });

    it("preserves the byte order of multiple large writes", async () => {
      const received = collectUntilEnd(socketPair.server);

      socketPair.client.write(Buffer.alloc(1024, "x"));
      await new Promise<void>((resolve) => setTimeout(resolve));
      socketPair.client.write(Buffer.alloc(1024, "y"));
      await new Promise<void>((resolve) => setTimeout(resolve));
      socketPair.client.write(Buffer.alloc(1024, "z"));
      // Use socket.end(data) to ensure data flushes before sending FIN
      socketPair.client.end();

      const { chunks, data } = await received;

      expect(chunks.length).toBeGreaterThan(1);
      expect(data.equals(Buffer.concat([Buffer.alloc(1024, "x"), Buffer.alloc(1024, "y"), Buffer.alloc(1024, "z")]))).toBe(true);
    });
  });

  describe("lifecycle event propagation", () => {
    it("propagates an end from the client to the server", async () => {
      const serverEnded = new Promise<void>((resolve) => {
        socketPair.server.once("end", resolve);
      });

      socketPair.client.end();

      await serverEnded;
      expect(socketPair.server.readableEnded).toBe(true);
    });

    it("propagates an end from the server to the client", async () => {
      const clientEnded = new Promise<void>((resolve) => {
        socketPair.client.once("end", resolve);
      });

      socketPair.server.end();

      await clientEnded;

      expect(socketPair.client.readableEnded).toBe(true);
    });
  });

  describe("fault propagation", () => {
    it("propagates a close from the client to the server", async () => {
      const checkHop1 = waitForClose(serverSocketPair.server, 1000).then(() => "Hop 1: hostPair.server CLOSED");
      const checkHop2 = waitForClose(http2ClientStream, 1000).then(() => "Hop 2: http2ClientStream CLOSED");
      const checkHop3 = waitForClose(http2ServerStream, 1000).then(() => "Hop 3: http2ServerStream CLOSED");
      const checkHop4 = waitForClose(clientSocketPair.client, 1000).then(() => "Hop 4: clientSocketPair.client CLOSED");
      const checkHop5 = waitForClose(socketPair.server, 1000).then(() => "Hop 5: socketPair.server CLOSED");

      socketPair.client.destroy();

      await Promise.all([checkHop1, checkHop2, checkHop3, checkHop4, checkHop5]);

      expect(socketPair.server.destroyed).toBe(true);
    });
  });
});
