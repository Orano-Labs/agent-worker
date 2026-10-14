import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { type ClientHttp2Session, type ClientHttp2Stream, connect, type Http2Stream } from "node:http2";
import type { Socket } from "node:net";
import { setTimeout } from "node:timers/promises";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { SocketPair } from "./socket-pair";
import { TunnelGuest } from "./tunnel-guest";

describe("TunnelGuest", () => {
  let targetServer: ReturnType<typeof createHttpServer>;

  beforeEach(async () => {
    targetServer = createHttpServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  });

  const collectStreamUntilEnd = (stream: Http2Stream | Socket) => {
    const chunks: Buffer[] = [];

    return new Promise<{ chunks: Buffer[]; data: Buffer }>((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.once("end", () => resolve({ chunks, data: Buffer.concat(chunks) }));
      stream.once("error", reject);
    });
  };

  it("should create connections up to the configured concurrency on startup", async () => {
    const pair = new SocketPair();

    await pair.ready();

    const createConnectionMock = vi.fn(async () => {
      return pair.create().then(({ server }) => server);
    });

    const guest = new TunnelGuest({
      concurrency: 128,
      router: async () => {},
      createConnection: createConnectionMock,
    });

    expect(createConnectionMock).toHaveBeenCalledTimes(128);

    await pair.close();
    await guest.close();
  });

  it("should handle up to the configured concurrency of concurrent CONNECT streams", async () => {
    const pair = new SocketPair();
    const sockets = await pair.create();

    const guest = new TunnelGuest({
      concurrency: 1,
      router: async () => {},
      createConnection: async () => sockets.server,
    });

    const session = await new Promise<ClientHttp2Session>((resolve, reject) => {
      const client = connect("http://localhost:8000", {
        createConnection: () => {
          return sockets.client;
        },
      });

      client.once("connect", () => {
        resolve(client);
      });

      client.once("error", (error) => {
        reject(error);
      });
    });

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve, reject) => {
        session
          .request({
            ":method": "CONNECT",
            ":path": "/",
            ":authority": "example.com:8080",
            ":scheme": "http",
            ":protocol": "tcp",
          })
          .once("response", resolve)
          .once("error", reject);
      });
    }

    expect(guest.streams).toBe(10);

    await pair.close();
    await guest.close();
  });

  it("should tunnel duplex data over a CONNECT stream and close both ends together", async () => {
    const pair = new SocketPair();
    const sockets = await pair.create();

    let socket: Socket | undefined;

    const guest = new TunnelGuest({
      concurrency: 1,
      router: (s) => {
        socket = s;
      },
      createConnection: async () => sockets.server,
    });

    const session = await new Promise<ClientHttp2Session>((resolve, reject) => {
      const client = connect("http://localhost:8000", {
        createConnection: () => {
          return sockets.client;
        },
      });

      client.once("connect", () => {
        resolve(client);
      });

      client.once("error", (error) => {
        reject(error);
      });
    });

    const stream = await new Promise<ClientHttp2Stream>((resolve, reject) => {
      const stream = session
        .request({
          ":method": "CONNECT",
          ":authority": "example.com:8080",
          ":protocol": "tcp",
        })
        .once("response", () => resolve(stream))
        .once("error", reject);
    });

    assert(socket);
    expect(guest.streams).toBe(1);

    const socketReceived = collectStreamUntilEnd(socket);
    const streamReceived = collectStreamUntilEnd(stream);

    const socketSent = randomBytes(128);
    const streamSent = randomBytes(128);

    socket.end(socketSent);
    stream.end(streamSent);

    const [socketReceivedData, streamReceivedData] = await Promise.all([
      socketReceived.then(({ data }) => data),
      streamReceived.then(({ data }) => data),
    ]);

    expect(socketReceivedData.equals(streamSent)).toBe(true);
    expect(streamReceivedData.equals(socketSent)).toBe(true);

    await setTimeout(10);

    expect(socket.closed).toBe(true);
    expect(stream.closed).toBe(true);

    await pair.close();
    await guest.close();
  });

  it("should route plain http requests through tunnel", async () => {
    const pair = new SocketPair();
    const sockets = await pair.create();

    const requests = {} as Record<string, number>;

    targetServer.on("request", (req, res) => {
      requests[req.method || "UNKNOWN"] = (requests[req.method || "UNKNOWN"] ?? 0) + 1;

      res.end("ok");
    });

    const guest = new TunnelGuest({
      concurrency: 1,
      router: (socket) => targetServer.emit("connection", socket),
      createConnection: async () => sockets.server,
    });

    const session = await new Promise<ClientHttp2Session>((resolve, reject) => {
      const client = connect("http://localhost:8000", {
        createConnection: () => {
          return sockets.client;
        },
      });

      client.once("connect", () => {
        resolve(client);
      });

      client.once("error", (error) => {
        reject(error);
      });
    });

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve, reject) => {
        const stream = session
          .request({
            ":method": "CONNECT",
            ":authority": "example.com:8080",
            ":protocol": "tcp",
          })
          .on("data", () => {})
          .once("response", () => {
            stream.end(`${i % 2 === 0 ? "GET" : "POST"} / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n`);
          })
          .once("error", reject)
          .once("close", resolve);
      });
    }

    expect(requests.GET).toBe(5);
    expect(requests.POST).toBe(5);

    await pair.close();
    await guest.close();
  });

  it("should keep a persistent connection alive across multiple requests (keepalive)", async () => {
    const pair = new SocketPair();
    const sockets = await pair.create();

    const requests: string[] = [];
    const connectionCount = { value: 0 };

    targetServer.on("connection", () => {
      connectionCount.value += 1;
    });

    targetServer.on("request", (req, res) => {
      requests.push(req.method || "UNKNOWN");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });

    const guest = new TunnelGuest({
      concurrency: 1,
      router: (socket) => targetServer.emit("connection", socket),
      createConnection: async () => sockets.server,
    });

    const session = await new Promise<ClientHttp2Session>((resolve, reject) => {
      const client = connect("http://localhost:8000", {
        createConnection: () => sockets.client,
      });

      client.once("connect", () => resolve(client));
      client.once("error", reject);
    });

    await new Promise<void>((resolve, reject) => {
      const stream = session
        .request({
          ":method": "CONNECT",
          ":authority": "example.com:8080",
          ":protocol": "tcp",
        })
        .on("data", () => {})
        .once("response", () => {
          let i = 0;

          const timer = setInterval(() => {
            if (i >= 5) {
              stream.end();
              clearInterval(timer);

              return;
            }

            stream.write(`GET /req-${i} HTTP/1.1\r\nHost: example.com\r\nConnection: keep-alive\r\n\r\n`);

            i++;
          }, 10);
        })
        .once("error", reject)
        .once("close", resolve);
    });

    expect(requests.length).toBe(5);
    expect(requests.every((m) => m === "GET")).toBe(true);
    expect(connectionCount.value).toBe(1);

    await pair.close();
    await guest.close();
  });

  it("should handle http upgrade and keep the upgraded connection alive", async () => {
    const pair = new SocketPair();
    const sockets = await pair.create();

    const upgradeResponseHeader = Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");

    targetServer.on("upgrade", (req, socket, head) => {
      if (req.headers.upgrade?.toLowerCase() !== "websocket") {
        socket.destroy();
        return;
      }

      socket.write(upgradeResponseHeader);

      if (head && head.length > 0) {
        socket.write(head);
      }

      socket.on("end", () => socket.end());
      socket.on("data", (chunk) => {
        setImmediate(() => {
          socket.write(chunk);
        });
      });
    });

    const guest = new TunnelGuest({
      concurrency: 1,
      router: (socket) => targetServer.emit("connection", socket),
      createConnection: async () => sockets.server,
    });

    const session = await new Promise<ClientHttp2Session>((resolve, reject) => {
      const client = connect("http://localhost:8000", {
        createConnection: () => sockets.client,
      });

      client.once("connect", () => resolve(client));
      client.once("error", reject);
    });

    let received = Buffer.alloc(0);
    let sent = Buffer.alloc(0);

    await new Promise<void>((resolve, reject) => {
      const onReadable = () => {
        const header = stream.read(upgradeResponseHeader.byteLength) as Buffer | null;

        if (header === null) {
          return;
        }

        stream.off("readable", onReadable);

        const interval = setInterval(() => {
          if (sent.byteLength < 1024 * 1024) {
            const bytes = randomBytes(1024 * 4);

            sent = Buffer.concat([sent, bytes]);

            stream.write(bytes);
          } else {
            stream.end();
            interval.close();
          }
        });

        stream.on("data", (chunk) => {
          received = Buffer.concat([received, Buffer.from(chunk)]);
        });
      };

      const stream = session
        .request({
          ":method": "CONNECT",
          ":authority": "example.com:8080",
          ":protocol": "tcp",
        })
        .on("readable", onReadable)
        .once("response", () => {
          stream.write("GET /chat HTTP/1.1\r\nHost: example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        })
        .once("error", reject)
        .once("close", resolve);
    });

    expect(sent.equals(received)).toBe(true);

    await pair.close();
    await guest.close();
  });
});
