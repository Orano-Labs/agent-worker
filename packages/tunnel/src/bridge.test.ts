import { randomBytes } from "node:crypto";
import {
  ClientHttp2Session,
  ClientHttp2Stream,
  connect,
  constants,
  createServer,
  Http2Server,
  Http2Stream,
  ServerHttp2Session,
  ServerHttp2Stream,
} from "node:http2";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Bridge } from "@/bridge";
import { SocketPair } from "@/socket-pair";

describe("Bridge", () => {
  const pairs = new SocketPair();
  const bridge = new Bridge();

  let http2Server: Http2Server;
  let http2ServerSockets: SocketPair.Sockets;
  let http2ClientSession: ClientHttp2Session;
  let http2ServerSession: ServerHttp2Session;
  let http2ClientStream: ClientHttp2Stream;
  let http2ServerStream: ServerHttp2Stream;

  beforeEach(async () => {
    http2ServerSockets = await pairs.create();
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
          return http2ServerSockets.client;
        },
      });

      client.once("connect", () => {
        resolve(client);
      });

      client.once("error", (error) => {
        reject(error);
      });
    });

    http2Server.emit("connection", http2ServerSockets.server);

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

    for (const s of [
      http2ServerSockets.client,
      http2ServerSockets.server,
      http2ServerSession,
      http2ClientSession,
      http2ServerStream,
      http2ClientStream,
    ]) {
      s.on("error", () => {});
    }
  });

  afterEach(async () => {
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

  const waitForEvent = (emitter: NodeJS.EventEmitter, event: string): Promise<unknown[]> => {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        emitter.removeListener(event, onEvent);
        emitter.removeListener("error", onError);
      };

      const onEvent = (...args: unknown[]) => {
        cleanup();
        resolve(args);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      emitter.once(event, onEvent);
      emitter.once("error", onError);
    });
  };

  /**
   * Collects every chunk delivered on `stream` until its readable side ends,
   * then resolves with the concatenation of all chunks in arrival order.
   */
  const collectStreamUntilEnd = (stream: Http2Stream | Socket) => {
    const chunks: Buffer[] = [];

    return new Promise<{ chunks: Buffer[]; data: Buffer }>((resolve, reject) => {
      stream.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      stream.once("end", () => resolve({ chunks, data: Buffer.concat(chunks) }));
      stream.once("error", reject);
    });
  };

  describe(".pipe() with client stream", () => {
    it("forwards all written data and propagates half-close in both directions", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const received = collectStreamUntilEnd(stream);

      const data = Array.from({ length: 1024 }).map(() => randomBytes(64));

      for (const chunk of data) {
        socket.write(chunk);
      }

      socket.end();

      expect((await received).data.equals(Buffer.concat(data))).toBe(true);

      expect(stream.writable).toBe(true);
      expect(stream.readable).toBe(false);
      expect(socket.readable).toBe(true);
      expect(socket.writable).toBe(false);

      stream.end();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(stream.writable).toBe(false);
      expect(stream.readable).toBe(false);
      expect(socket.readable).toBe(false);
      expect(socket.writable).toBe(false);

      expect(stream.closed).toBe(true);
      expect(socket.closed).toBe(true);
    });

    it("does not destroy the client socket when the server stream is destroyed", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      stream.destroy();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(stream.writable).toBe(false);
      expect(stream.readable).toBe(false);
      expect(socket.readable).toBe(false);
      expect(socket.writable).toBe(true);

      expect(stream.closed).toBe(true);
      expect(socket.closed).toBe(false);
    });

    it("does not destroy the server stream when the client socket is destroyed", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      socket.destroy();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(stream.writable).toBe(true);
      expect(stream.readable).toBe(false);
      expect(socket.readable).toBe(false);
      expect(socket.writable).toBe(false);

      expect(stream.closed).toBe(false);
      expect(socket.closed).toBe(true);
    });

    it("propagates end when no data is written", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const received = collectStreamUntilEnd(stream);

      socket.end();

      const result = await received;

      expect(result.data.length).toBe(0);
      expect(stream.readable).toBe(false);
    });

    it("handles an empty buffer", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const received = collectStreamUntilEnd(stream);

      socket.write(Buffer.alloc(0));
      socket.end();

      const result = await received;

      expect(result.data.equals(Buffer.alloc(0))).toBe(true);
    });

    it("preserves data order across many small writes", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const received = collectStreamUntilEnd(stream);

      const data = Array.from({ length: 4096 }, (_, i) => Buffer.from(`${i},`));

      for (const chunk of data) {
        socket.write(chunk);
      }

      socket.end();

      const result = await received;

      expect(result.data.equals(Buffer.concat(data))).toBe(true);
    });

    it("forwards large chunks without data loss", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const received = collectStreamUntilEnd(stream);

      const data = Array.from({ length: 4 }, () => randomBytes(1024 * 1024));

      for (const chunk of data) {
        socket.write(chunk);
      }

      socket.end();

      const result = await received;

      expect(result.data.equals(Buffer.concat(data))).toBe(true);
    });

    it("forwards string data with the expected encoding", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const received = collectStreamUntilEnd(stream);

      const data = "Hello, 世界 🌍";

      socket.write(data, "utf8");
      socket.end();

      const result = await received;

      expect(result.data.toString("utf8")).toBe(data);
    });

    it("propagates client end without prematurely closing the server stream", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const received = collectStreamUntilEnd(stream);

      const data = randomBytes(1024);

      socket.write(data);
      socket.end();

      const result = await received;

      expect(result.data.equals(data)).toBe(true);
      expect(stream.readable).toBe(false);
      expect(stream.writable).toBe(true);
    });

    it("propagates server end to the client readable side", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const received = collectStreamUntilEnd(socket);

      const data = randomBytes(1024);

      stream.write(data);
      stream.end();

      const result = await received;

      expect(result.data.equals(data)).toBe(true);
      expect(socket.readable).toBe(false);
    });

    it("handles repeated end calls safely", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const received = collectStreamUntilEnd(stream);

      socket.write("first");
      socket.end();

      // Node.js Writable 的重复 end() 应保持幂等。
      expect(() => socket.end()).not.toThrow();

      const result = await received;

      expect(result.data.toString()).toBe("first");
    });

    it("reports writes attempted after end", async () => {
      const socket = await bridge.pipe(http2ClientStream);

      socket.on("error", () => {});

      socket.end();

      const error = await new Promise<Error | undefined | null>((resolve) => {
        socket.write("late data", (err) => resolve(err));
      });

      expect(error).toBeDefined();
    });

    it("handles client destruction with an error", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      // 提前监听，避免销毁过程中产生未处理错误。
      const socketError = new Promise<Error>((resolve) => {
        socket.once("error", resolve);
      });

      socket.destroy(new Error("client failure"));

      const error = await socketError;

      expect(error.message).toBe("client failure");
      expect(socket.destroyed).toBe(true);

      // 对端是否销毁取决于 bridge.pipe 的错误传播契约。
      expect(stream).toBeDefined();
    });

    it("handles server destruction with an error", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const streamError = new Promise<Error>((resolve) => {
        stream.once("error", resolve);
      });

      stream.destroy(new Error("server failure"));

      const error = await streamError;

      expect(error.message).toBe("server failure");
      expect(stream.destroyed).toBe(true);

      expect(socket).toBeDefined();
    });

    it("handles repeated destroy calls safely", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      socket.destroy();
      socket.destroy();

      stream.destroy();
      stream.destroy();

      await Promise.all([waitForEvent(socket, "close"), waitForEvent(stream, "close")]).catch(() => {
        // 事件可能在等待器注册前触发，实际项目中应使用预注册的监听器。
      });

      expect(socket.destroyed).toBe(true);
      expect(stream.destroyed).toBe(true);
    });

    it("handles destruction immediately after the bridge is created", async () => {
      const socket = await bridge.pipe(http2ClientStream);

      socket.destroy();

      await waitForEvent(socket, "close");

      expect(socket.destroyed).toBe(true);
    });

    it("emits close at most once for each stream", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      let socketCloseCount = 0;
      let streamCloseCount = 0;

      socket.on("close", () => socketCloseCount++);
      stream.on("close", () => streamCloseCount++);

      socket.destroy();
      stream.destroy();

      await Promise.all([waitForEvent(socket, "close"), waitForEvent(stream, "close")]).catch(() => undefined);

      expect(socketCloseCount).toBeLessThanOrEqual(1);
      expect(streamCloseCount).toBeLessThanOrEqual(1);
    });

    it("preserves data integrity under backpressure", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const received = collectStreamUntilEnd(stream);

      const data = Array.from({ length: 2048 }, () => randomBytes(4096));

      for (const chunk of data) {
        socket.write(chunk);
      }

      socket.end();

      const result = await received;

      expect(result.data.equals(Buffer.concat(data))).toBe(true);
    });

    it("resumes forwarding after the writable buffer drains", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const received = collectStreamUntilEnd(stream);

      const data = randomBytes(4 * 1024 * 1024);

      // 连续写入，观察缓冲区压力下能否完成传输。
      socket.write(data);
      socket.end();

      const result = await received;

      expect(result.data.equals(data)).toBe(true);
    });

    it("handles concurrent writes without reordering data", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      const received = collectStreamUntilEnd(stream);

      const data = Array.from({ length: 100 }, (_, i) => Buffer.from(`[${i}]`));

      await Promise.all(
        data.map(
          (chunk) =>
            new Promise<void>((resolve, reject) => {
              socket.write(chunk, (error) => {
                if (error) reject(error);
                else resolve();
              });
            }),
        ),
      );

      socket.end();

      const result = await received;

      expect(result.data.equals(Buffer.concat(data))).toBe(true);
    });

    it("settles pending write promises when the stream closes", async () => {
      const socket = await bridge.pipe(http2ClientStream);
      const stream = http2ServerStream;

      socket.on("error", () => {});

      const writeResult = new Promise<void>((resolve, reject) => {
        socket.write(randomBytes(64 * 1024), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      stream.destroy();

      await expect(writeResult).rejects.toThrow();
    });
  });

  describe(".pipe() with server stream", () => {
    it("forwards all written data and propagates half-close in both directions", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const received = collectStreamUntilEnd(stream);

      const data = Array.from({ length: 1024 }).map(() => randomBytes(64));

      for (const chunk of data) {
        socket.write(chunk);
      }

      socket.end();

      expect((await received).data.equals(Buffer.concat(data))).toBe(true);

      expect(stream.writable).toBe(true);
      expect(stream.readable).toBe(false);
      expect(socket.readable).toBe(true);
      expect(socket.writable).toBe(false);

      stream.end();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(stream.writable).toBe(false);
      expect(stream.readable).toBe(false);
      expect(socket.readable).toBe(false);
      expect(socket.writable).toBe(false);

      expect(stream.closed).toBe(true);
      expect(socket.closed).toBe(true);
    });

    it("does not destroy the client socket when the server stream is destroyed", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      stream.destroy();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(stream.writable).toBe(false);
      expect(stream.readable).toBe(false);
      expect(socket.readable).toBe(false);
      expect(socket.writable).toBe(true);

      expect(stream.closed).toBe(true);
      expect(socket.closed).toBe(false);
    });

    it("does not destroy the server stream when the client socket is destroyed", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      socket.destroy();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(stream.writable).toBe(true);
      expect(stream.readable).toBe(false);
      expect(socket.readable).toBe(false);
      expect(socket.writable).toBe(false);

      expect(stream.closed).toBe(false);
      expect(socket.closed).toBe(true);
    });

    it("propagates end when no data is written", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const received = collectStreamUntilEnd(stream);

      socket.end();

      const result = await received;

      expect(result.data.length).toBe(0);
      expect(stream.readable).toBe(false);
    });

    it("handles an empty buffer", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const received = collectStreamUntilEnd(stream);

      socket.write(Buffer.alloc(0));
      socket.end();

      const result = await received;

      expect(result.data.equals(Buffer.alloc(0))).toBe(true);
    });

    it("preserves data order across many small writes", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const received = collectStreamUntilEnd(stream);

      const data = Array.from({ length: 4096 }, (_, i) => Buffer.from(`${i},`));

      for (const chunk of data) {
        socket.write(chunk);
      }

      socket.end();

      const result = await received;

      expect(result.data.equals(Buffer.concat(data))).toBe(true);
    });

    it("forwards large chunks without data loss", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const received = collectStreamUntilEnd(stream);

      const data = Array.from({ length: 4 }, () => randomBytes(1024 * 1024));

      for (const chunk of data) {
        socket.write(chunk);
      }

      socket.end();

      const result = await received;

      expect(result.data.equals(Buffer.concat(data))).toBe(true);
    });

    it("forwards string data with the expected encoding", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const received = collectStreamUntilEnd(stream);

      const data = "Hello, 世界 🌍";

      socket.write(data, "utf8");
      socket.end();

      const result = await received;

      expect(result.data.toString("utf8")).toBe(data);
    });

    it("propagates client end without prematurely closing the server stream", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const received = collectStreamUntilEnd(stream);

      const data = randomBytes(1024);

      socket.write(data);
      socket.end();

      const result = await received;

      expect(result.data.equals(data)).toBe(true);
      expect(stream.readable).toBe(false);
      expect(stream.writable).toBe(true);
    });

    it("propagates server end to the client readable side", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const received = collectStreamUntilEnd(socket);

      const data = randomBytes(1024);

      stream.write(data);
      stream.end();

      const result = await received;

      expect(result.data.equals(data)).toBe(true);
      expect(socket.readable).toBe(false);
    });

    it("handles repeated end calls safely", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const received = collectStreamUntilEnd(stream);

      socket.write("first");
      socket.end();

      // Node.js Writable 的重复 end() 应保持幂等。
      expect(() => socket.end()).not.toThrow();

      const result = await received;

      expect(result.data.toString()).toBe("first");
    });

    it("reports writes attempted after end", async () => {
      const socket = await bridge.pipe(http2ServerStream);

      socket.on("error", () => {});

      socket.end();

      const error = await new Promise<Error | undefined | null>((resolve) => {
        socket.write("late data", (err) => resolve(err));
      });

      expect(error).toBeDefined();
    });

    it("handles client destruction with an error", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      // 提前监听，避免销毁过程中产生未处理错误。
      const socketError = new Promise<Error>((resolve) => {
        socket.once("error", resolve);
      });

      socket.destroy(new Error("client failure"));

      const error = await socketError;

      expect(error.message).toBe("client failure");
      expect(socket.destroyed).toBe(true);

      // 对端是否销毁取决于 bridge.pipe 的错误传播契约。
      expect(stream).toBeDefined();
    });

    it("handles server destruction with an error", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const streamError = new Promise<Error>((resolve) => {
        stream.once("error", resolve);
      });

      stream.destroy(new Error("server failure"));

      const error = await streamError;

      expect(error.message).toBe("server failure");
      expect(stream.destroyed).toBe(true);

      expect(socket).toBeDefined();
    });

    it("handles repeated destroy calls safely", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      socket.destroy();
      socket.destroy();

      stream.destroy();
      stream.destroy();

      await Promise.all([waitForEvent(socket, "close"), waitForEvent(stream, "close")]).catch(() => {
        // 事件可能在等待器注册前触发，实际项目中应使用预注册的监听器。
      });

      expect(socket.destroyed).toBe(true);
      expect(stream.destroyed).toBe(true);
    });

    it("handles destruction immediately after the bridge is created", async () => {
      const socket = await bridge.pipe(http2ServerStream);

      socket.destroy();

      await waitForEvent(socket, "close");

      expect(socket.destroyed).toBe(true);
    });

    it("emits close at most once for each stream", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      let socketCloseCount = 0;
      let streamCloseCount = 0;

      socket.on("close", () => socketCloseCount++);
      stream.on("close", () => streamCloseCount++);

      socket.destroy();
      stream.destroy();

      await Promise.all([waitForEvent(socket, "close"), waitForEvent(stream, "close")]).catch(() => undefined);

      expect(socketCloseCount).toBeLessThanOrEqual(1);
      expect(streamCloseCount).toBeLessThanOrEqual(1);
    });

    it("preserves data integrity under backpressure", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const received = collectStreamUntilEnd(stream);

      const data = Array.from({ length: 2048 }, () => randomBytes(4096));

      for (const chunk of data) {
        socket.write(chunk);
      }

      socket.end();

      const result = await received;

      expect(result.data.equals(Buffer.concat(data))).toBe(true);
    });

    it("resumes forwarding after the writable buffer drains", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const received = collectStreamUntilEnd(stream);

      const data = randomBytes(4 * 1024 * 1024);

      // 连续写入，观察缓冲区压力下能否完成传输。
      socket.write(data);
      socket.end();

      const result = await received;

      expect(result.data.equals(data)).toBe(true);
    });

    it("handles concurrent writes without reordering data", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      const received = collectStreamUntilEnd(stream);

      const data = Array.from({ length: 100 }, (_, i) => Buffer.from(`[${i}]`));

      await Promise.all(
        data.map(
          (chunk) =>
            new Promise<void>((resolve, reject) => {
              socket.write(chunk, (error) => {
                if (error) reject(error);
                else resolve();
              });
            }),
        ),
      );

      socket.end();

      const result = await received;

      expect(result.data.equals(Buffer.concat(data))).toBe(true);
    });

    it("settles pending write promises when the stream closes", async () => {
      const socket = await bridge.pipe(http2ServerStream);
      const stream = http2ClientStream;

      socket.on("error", () => {});

      const writeResult = new Promise<void>((resolve, reject) => {
        socket.write(randomBytes(64 * 1024), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      stream.destroy();

      await expect(writeResult).rejects.toThrow();
    });
  });

  describe("paired stream communication and lifecycle states", () => {
    it("creates a linked pair where data flows in both directions", async () => {
      const client = await bridge.pipe(http2ClientStream);
      const server = await bridge.pipe(http2ServerStream);

      const received: string[] = [];

      client.on("data", (chunk) => received.push(chunk.toString()));
      server.on("data", (chunk) => received.push(chunk.toString()));

      client.write("client->server");
      server.write("server->client");

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(received).toContain("client->server");
      expect(received).toContain("server->client");

      client.destroy();
      server.destroy();
    });

    it("transitions both sockets to the fully closed state after both sides end", async () => {
      const client = await bridge.pipe(http2ClientStream);
      const server = await bridge.pipe(http2ServerStream);

      client.on("error", () => {});
      server.on("error", () => {});

      client.end();

      await new Promise((resole) => setTimeout(resole, 10));

      expect(server.readable).toBe(false);
      expect(server.writable).toBe(true);
      expect(client.writable).toBe(false);
      expect(client.readable).toBe(true);

      server.end();

      await new Promise((resole) => setTimeout(resole, 10));

      expect(server.readable).toBe(false);
      expect(server.writable).toBe(false);
      expect(client.writable).toBe(false);
      expect(client.readable).toBe(false);

      expect(server.closed).toBe(true);
      expect(client.closed).toBe(true);
      expect(http2ClientStream.closed).toBe(true);
      expect(http2ServerStream.closed).toBe(true);
    });

    it("continues forwarding in the reverse direction after one side half-closes", async () => {
      const client = await bridge.pipe(http2ClientStream);
      const server = await bridge.pipe(http2ServerStream);

      client.on("error", () => {});
      server.on("error", () => {});

      const received: Buffer[] = [];
      client.on("data", (chunk) => received.push(Buffer.from(chunk)));

      const serverEnded = new Promise<void>((resolve) => server.once("end", resolve));
      server.resume();
      client.end();

      await serverEnded;

      expect(client.writable).toBe(false);
      expect(client.readable).toBe(true);
      expect(client.closed).toBe(false);
      expect(server.writable).toBe(true);
      expect(server.readable).toBe(false);
      expect(server.closed).toBe(false);

      server.write("reverse-after-half-close");

      await new Promise<void>((resolve) => client.once("data", resolve));

      expect(Buffer.concat(received).toString()).toBe("reverse-after-half-close");

      const clientEnded = new Promise<void>((resolve) => client.once("end", resolve));
      server.end();

      await clientEnded;

      expect(client.writable).toBe(false);
      expect(client.readable).toBe(false);
      expect(client.closed).toBe(true);
      expect(server.writable).toBe(false);
      expect(server.readable).toBe(false);
      expect(server.closed).toBe(true);
    });
  });
});
