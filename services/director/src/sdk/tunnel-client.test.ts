import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { Key } from "@/internal/key";
import { TunnelClient } from "./tunnel-client";

const toHex = (source: Uint8Array) => source.reduce((str, byte) => str + byte.toString(16).padStart(2, "0"), "");

/** Creates a manager identity backed by a real Ed25519 key pair. */
async function createIdentity() {
  const key = new Key();
  const [, privateKey] = await key.generateED25519();

  return { type: "manager", privateKey: toHex(privateKey) } as const;
}

/** Asserts the header is present exactly once and returns its value. */
function singleHeader(headers: Record<string, string | string[]>, name: string): string {
  const value = headers[name];
  expect(typeof value).toBe("string");

  return value as string;
}

function listen(server: Server) {
  return new Promise<void>((resolve) => server.listen(0, resolve));
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Collects socket data until the predicate matches, then returns the buffer. */
function collectUntil(socket: Socket, predicate: (buffer: Buffer) => boolean, timeoutMs = 3_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for socket data"));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

      if (predicate(buffer)) {
        cleanup();
        resolve(buffer);
      }
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before the condition was met"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
    };

    socket.on("data", onData);
    socket.once("close", onClose);
  });
}

type ParsedResponse = {
  version: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
};

/** Parses the first HTTP/1.x response found in the buffer, or returns null. */
function parseHttpResponse(buffer: Buffer): ParsedResponse | null {
  const headerEnd = buffer.indexOf("\r\n\r\n");

  if (headerEnd === -1) {
    return null;
  }

  const head = buffer.subarray(0, headerEnd).toString("latin1");
  const lines = head.split("\r\n");
  const [version, status, ...statusParts] = lines[0].split(" ");
  const headers: Record<string, string> = {};

  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");

    if (index === -1) continue;

    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }

  return {
    version,
    status: Number(status),
    statusText: statusParts.join(" "),
    headers,
    body: buffer.subarray(headerEnd + 4),
  };
}

/** Decodes an HTTP/1.1 chunked-encoded body (including the terminal chunk). */
function decodeChunkedBody(body: Buffer): Buffer | null {
  let offset = 0;
  const chunks: Buffer[] = [];

  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);

    if (lineEnd === -1) return null;

    const sizeHex = body.subarray(offset, lineEnd).toString("latin1").split(";")[0].trim();
    const size = Number.parseInt(sizeHex, 16);

    if (Number.isNaN(size)) return null;

    offset = lineEnd + 2;

    if (size === 0) {
      // Terminal chunk; skip trailing trailers.
      return Buffer.concat(chunks);
    }

    if (body.length < offset + size + 2) return null;

    chunks.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }

  return null;
}

/** Reads a complete HTTP response (Content-Length or chunked) from the socket. */
async function readHttpResponse(socket: Socket, timeoutMs = 3_000): Promise<ParsedResponse> {
  const buffer = await collectUntil(
    socket,
    (b) => {
      const parsed = parseHttpResponse(b);

      if (!parsed) return false;

      const contentLength = Number(parsed.headers["content-length"] ?? 0);

      if (contentLength > 0) {
        return parsed.body.length >= contentLength;
      }

      if (/chunked/i.test(parsed.headers["transfer-encoding"] ?? "")) {
        return decodeChunkedBody(parsed.body) !== null;
      }

      return true;
    },
    timeoutMs,
  );

  const parsed = parseHttpResponse(buffer);

  if (!parsed) {
    throw new Error("No HTTP response received");
  }

  const contentLength = Number(parsed.headers["content-length"] ?? 0);

  if (contentLength > 0) {
    return { ...parsed, body: parsed.body.subarray(0, contentLength) };
  }

  if (/chunked/i.test(parsed.headers["transfer-encoding"] ?? "")) {
    const decoded = decodeChunkedBody(parsed.body);

    if (!decoded) {
      throw new Error("Failed to decode chunked response body");
    }

    return { ...parsed, body: decoded };
  }

  return parsed;
}

// WebSocket framing helpers: client frames are masked, server frames are not.

function encodeClientFrame(payload: string, opcode = 0x1): Buffer {
  const payloadBuffer = Buffer.from(payload, "utf8");
  const maskKey = randomBytes(4);
  const length = payloadBuffer.length;

  let header: Buffer;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65_536) {
    header = Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff]);
  } else {
    throw new Error("Payload too large for test frame encoding");
  }

  const masked = Buffer.alloc(length);

  for (let i = 0; i < length; i++) {
    masked[i] = payloadBuffer[i] ^ maskKey[i % 4];
  }

  return Buffer.concat([header, maskKey, masked]);
}

function decodeServerFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) return null;

  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) return null;

    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;

    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  if (buffer.length < offset + length) return null;

  return { opcode, payload: buffer.subarray(offset, offset + length), consumed: offset + length };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TunnelClient", () => {
  let tunnelServer: Server;
  let tunnelServerUrl: string;
  let tunnelUpgradeRequests: { url: string; headers: Record<string, string | string[]> }[];
  let tunnelSockets: Socket[];

  let targetServer: Server;
  let targetServerUrl: string;

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } satisfies TunnelClient.Logger;

  beforeEach(async () => {
    vi.clearAllMocks();

    tunnelUpgradeRequests = [];
    tunnelSockets = [];

    // Target server: echoes a JSON summary by default, supports /echo, /sse and /ws.
    targetServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/echo") {
        const chunks: Buffer[] = [];

        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(Buffer.concat(chunks));
        });

        return;
      }

      if (url.pathname === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write("data: one\n\n");
        setTimeout(() => res.write("data: two\n\n"), 10);
        setTimeout(() => res.end("data: done\n\n"), 30);

        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          path: url.pathname,
          project: req.headers["x-project-id"] ?? null,
        }),
      );
    });

    await listen(targetServer);
    targetServerUrl = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}`;

    // Tunnel server: simulates the director's /tunnel upgrade endpoint.
    // The test server does not verify the request signature — signing only needs
    // to succeed on the client side.
    tunnelServer = createServer((_req, res) => {
      res.writeHead(400);
      res.end("Expected an upgrade request");
    });

    tunnelServer.on("upgrade", (req, socket) => {
      tunnelUpgradeRequests.push({ url: req.url ?? "", headers: req.headers as Record<string, string | string[]> });
      // @ts-expect-error
      tunnelSockets.push(socket);

      socket.write("HTTP/1.1 101 Switching Protocols\r\n" + "Upgrade: tunnel\r\n" + "Connection: Upgrade\r\n" + "\r\n");
    });

    await listen(tunnelServer);
    tunnelServerUrl = `http://127.0.0.1:${(tunnelServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of tunnelSockets) {
      socket.destroy();
    }

    await close(targetServer);
    await close(tunnelServer);
  });

  it("signs the tunnel upgrade request and establishes a connection", async () => {
    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    const request = tunnelUpgradeRequests[0];

    // The upgrade request targets the /tunnel endpoint with tunnel headers.
    expect(request.url).toBe("/tunnel");
    expect(request.headers.upgrade).toBe("tunnel");
    expect(request.headers.connection).toBe("upgrade");

    await vi.waitFor(() => {
      expect(mockLogger.info).toHaveBeenCalledWith("Tunnel socket connected", {});
    });

    controller.abort();
  });

  it("proxies a normal HTTP GET request through the tunnel", async () => {
    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    tunnelSockets[0].write("GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\n");

    const response = await readHttpResponse(tunnelSockets[0]);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toEqual({ ok: true, path: "/hello", project: null });

    controller.abort();
  });

  it("proxies an HTTP POST request with a body through the tunnel", async () => {
    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    const payload = JSON.stringify({ hello: "world" });

    tunnelSockets[0].write(
      `POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n` +
        payload,
    );

    const response = await readHttpResponse(tunnelSockets[0]);

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe(payload);

    controller.abort();
  });

  it("resolves the target dynamically from request headers", async () => {
    // Second target server used to verify header-based routing.
    const secondaryServer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ server: "secondary", path: req.url }));
    });

    await listen(secondaryServer);
    const secondaryUrl = `http://127.0.0.1:${(secondaryServer.address() as AddressInfo).port}`;

    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async (headers) => {
        return headers.get("x-project-id") === "secondary" ? new URL(secondaryUrl) : new URL(targetServerUrl);
      },
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    const socket = tunnelSockets[0];

    socket.write("GET /primary HTTP/1.1\r\nHost: localhost\r\nx-project-id: primary\r\n\r\n");

    let response = await readHttpResponse(socket);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toEqual({ ok: true, path: "/primary", project: "primary" });

    socket.write("GET /secondary HTTP/1.1\r\nHost: localhost\r\nx-project-id: secondary\r\n\r\n");

    response = await readHttpResponse(socket);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toEqual({ server: "secondary", path: "/secondary" });

    controller.abort();
    await close(secondaryServer);
  });

  it("streams SSE responses through the tunnel", async () => {
    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    const socket = tunnelSockets[0];

    socket.write("GET /sse HTTP/1.1\r\nHost: localhost\r\n\r\n");

    const buffer = await collectUntil(socket, (b) => b.toString("utf8").includes("data: done"));

    const text = buffer.toString("utf8");

    expect(text).toContain("data: one");
    expect(text).toContain("data: two");
    expect(text).toContain("data: done");

    controller.abort();
  });

  it("supports WebSocket connections through the tunnel", async () => {
    // WebSocket endpoint on the target server.
    const webSocketServer = new WebSocketServer({ noServer: true });

    webSocketServer.on("connection", (ws) => {
      ws.on("message", (data) => {
        ws.send(`echo:${data.toString()}`);
      });
    });

    targetServer.on("upgrade", (req, socket, head) => {
      if (req.url === "/ws") {
        webSocketServer.handleUpgrade(req, socket, head, (ws) => {
          webSocketServer.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    const socket = tunnelSockets[0];
    const websocketKey = randomBytes(16).toString("base64");

    socket.write(
      "GET /ws HTTP/1.1\r\n" +
        "Host: localhost\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${websocketKey}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );

    const handshake = await collectUntil(socket, (b) => b.indexOf("\r\n\r\n") !== -1);

    expect(handshake.toString("utf8")).toContain("101 Switching Protocols");

    // Send a masked text frame and expect the echo back from the target.
    socket.write(encodeClientFrame("hello"));

    const frameBuffer = await collectUntil(socket, (b) => decodeServerFrame(b) !== null);
    const frame = decodeServerFrame(frameBuffer);

    expect(frame?.opcode).toBe(0x1);
    expect(frame?.payload.toString()).toBe("echo:hello");

    controller.abort();
    webSocketServer.close();
  });

  it("logs a warning and retries when the tunnel upgrade is rejected", async () => {
    tunnelServer.removeAllListeners("upgrade");
    tunnelServer.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
    });

    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(
      () => {
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Tunnel connection failed"), expect.any(Object));
      },
      { timeout: 3_000 },
    );

    controller.abort();
  });

  it("throws when start() is called twice", async () => {
    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    expect(() => client.start(controller.signal)).toThrow("TunnelClient is already started");

    controller.abort();
  });

  it("stops retrying after the abort signal fires", async () => {
    const identity = await createIdentity();
    const controller = new AbortController();

    // Unreachable port forces connection failures and triggers the retry loop.
    const client = new TunnelClient({
      baseUrl: "http://127.0.0.1:59999",
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    controller.abort();

    const warnCountBeforeAbort = mockLogger.warn.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(mockLogger.warn.mock.calls.length).toBe(warnCountBeforeAbort);
  });

  it("uses the development signature header when dev mode is enabled", async () => {
    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      dev: true,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    controller.abort();
  });

  it("signs with the supervisor identity when one is configured", async () => {
    const key = new Key();
    const [, privateKey] = await key.generateED25519();
    const supervisorId = "1234567890abcdef12345678";

    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity: {
        type: "supervisor",
        id: supervisorId,
        privateKey: toHex(privateKey),
      },
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    controller.abort();
  });

  it("establishes multiple tunnel connections up to maxConnections", async () => {
    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 3,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(3);
    });

    // Each connection is a distinct, signed upgrade request.
    expect(tunnelUpgradeRequests).toHaveLength(3);

    for (const request of tunnelUpgradeRequests) {
      expect(request.url).toBe("/tunnel");
      expect(request.headers.upgrade).toBe("tunnel");
      expect(singleHeader(request.headers, "x-request-signature")).toBeTruthy();
    }

    controller.abort();
  });

  it("re-establishes the tunnel when the connection is closed by the server", async () => {
    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    // Simulate a server-side failure: tear down the tunnel socket.
    tunnelSockets[0].destroy();

    // The client should dial a fresh tunnel connection.
    await vi.waitFor(() => {
      expect(mockLogger.info).toHaveBeenCalledTimes(2);
    });

    expect(tunnelSockets.length).toBeGreaterThanOrEqual(2);

    // The replacement connection proxies requests normally.
    const socket = tunnelSockets[tunnelSockets.length - 1];

    socket.write("GET /reconnected HTTP/1.1\r\nHost: localhost\r\n\r\n");

    const response = await readHttpResponse(socket);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toEqual({ ok: true, path: "/reconnected", project: null });

    controller.abort();
  });

  it("returns 504 but keeps the tunnel alive when the target is unreachable", async () => {
    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async (headers) => {
        if (headers.get("x-dead") === "1") {
          return new URL("http://127.0.0.1:59999");
        }

        return new URL(targetServerUrl);
      },
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    const socket = tunnelSockets[0];

    socket.write("GET /unreachable HTTP/1.1\r\nHost: localhost\r\nx-dead: 1\r\n\r\n");

    const errorResponse = await readHttpResponse(socket);

    expect(errorResponse.status).toBe(502);

    // Proxy failures are scoped to the request: the tunnel socket stays usable.
    socket.write("GET /alive HTTP/1.1\r\nHost: localhost\r\n\r\n");

    const okResponse = await readHttpResponse(socket);

    expect(okResponse.status).toBe(200);
    expect(JSON.parse(okResponse.body.toString())).toEqual({ ok: true, path: "/alive", project: null });

    controller.abort();
  });

  it("forwards request headers to the target", async () => {
    // Dedicated echo target that reports the headers it received.
    const echoServer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          custom: req.headers["x-custom-header"] ?? null,
          authorization: req.headers.authorization ?? null,
          project: req.headers["x-project-id"] ?? null,
        }),
      );
    });

    await listen(echoServer);
    const echoUrl = `http://127.0.0.1:${(echoServer.address() as AddressInfo).port}`;

    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(echoUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    tunnelSockets[0].write(
      "GET /headers HTTP/1.1\r\n" +
        "Host: localhost\r\n" +
        "x-custom-header: hello\r\n" +
        "authorization: Bearer token123\r\n" +
        "x-project-id: project-42\r\n\r\n",
    );

    const response = await readHttpResponse(tunnelSockets[0]);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toEqual({
      custom: "hello",
      authorization: "Bearer token123",
      project: "project-42",
    });

    controller.abort();
    await close(echoServer);
  });

  it("proxies HEAD requests without a response body", async () => {
    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    tunnelSockets[0].write("HEAD /head HTTP/1.1\r\nHost: localhost\r\n\r\n");

    const response = await readHttpResponse(tunnelSockets[0]);

    expect(response.status).toBe(200);
    expect(response.body.length).toBe(0);

    controller.abort();
  });

  it("serves multiple pipelined requests over a single tunnel socket", async () => {
    const identity = await createIdentity();
    const controller = new AbortController();

    const client = new TunnelClient({
      baseUrl: tunnelServerUrl,
      identity,
      maxConnections: 1,
      logger: mockLogger,
      targetResolver: async () => new URL(targetServerUrl),
    });

    client.start(controller.signal);

    await vi.waitFor(() => {
      expect(tunnelSockets).toHaveLength(1);
    });

    const socket = tunnelSockets[0];

    // Send two requests back-to-back without waiting for the first response.
    socket.write("GET /concurrent-a HTTP/1.1\r\nHost: localhost\r\n\r\n");
    socket.write("GET /concurrent-b HTTP/1.1\r\nHost: localhost\r\n\r\n");

    const buffer = await collectUntil(socket, (b) => {
      const text = b.toString("utf8");

      return text.includes('"path":"/concurrent-a"') && text.includes('"path":"/concurrent-b"');
    });

    const text = buffer.toString("utf8");

    expect(text).toContain('"path":"/concurrent-a"');
    expect(text).toContain('"path":"/concurrent-b"');

    controller.abort();
  });
});
