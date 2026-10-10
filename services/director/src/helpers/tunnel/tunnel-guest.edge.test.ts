import { createServer as createHttpServer, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SocketPair } from "./socket-pair";
import { TunnelGuest } from "./tunnel-guest";
import { TunnelHost } from "./tunnel-host";

/**
 * Stability and edge-case tests for the tunnel, driven against a local,
 * fully-controllable HTTP server (no external dependency, no network jitter).
 *
 * Each test installs a custom handler on the target server so the exact
 * response shape (size, framing, timing, encoding) can be exercised.
 */

describe("Tunnel stability and edge cases", { timeout: 30000 }, () => {
  let targetServer: HttpServer;
  let targetUrl: string;
  let handler: (req: import("node:http").IncomingMessage, res: ServerResponse) => void;

  beforeEach(async () => {
    targetServer = createHttpServer((req, res) => handler(req, res));

    await new Promise<void>((resolve) => targetServer.listen(0, resolve));

    targetUrl = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  });

  /** Wires a guest to `maxConnections` host transport sockets, upgrading each. */
  async function setup(maxConnections = 1) {
    const transport = new SocketPair({ socketPath: join(tmpdir(), `edge-transport-${process.pid}.sock`) });
    const peers: Socket[] = [];

    const guest = new TunnelGuest({
      maxConnections,
      router: () => new URL(targetUrl),
      createConnection: async () => {
        const pair = await transport.create();
        peers.push(pair.server);
        return pair.client;
      },
    });

    await waitUntil(() => peers.length === maxConnections);

    const host = new TunnelHost({ socketPath: join(tmpdir(), `edge-host-${process.pid}.sock`) });

    for (const peer of peers) {
      await host.upgrade(peer);
    }

    return { transport, peers, guest, host };
  }

  async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for condition");
      }

      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Reads a complete HTTP/1.1 response off a socket, returning the body as a
   * Buffer (binary-safe). Handles Content-Length and chunked framing.
   */
  function readResponse(socket: Socket): Promise<{ status: number; headers: string; body: Buffer }> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out reading response; got ${buffer.length} bytes so far`));
      }, 10000);

      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

        const parsed = tryParse(buffer);

        if (parsed) {
          cleanup();
          resolve(parsed);
        }
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("data", onData);
        socket.off("error", onError);
      };

      socket.on("data", onData);
      socket.once("error", onError);
    });
  }

  function tryParse(buffer: Buffer): { status: number; headers: string; body: Buffer } | null {
    const headerEnd = buffer.indexOf("\r\n\r\n");

    if (headerEnd === -1) return null;

    const head = buffer.subarray(0, headerEnd).toString("latin1");
    const status = Number(head.split(" ")[1]);
    const rest = buffer.subarray(headerEnd + 4);

    if (/transfer-encoding:\s*chunked/i.test(head)) {
      const body = decodeChunks(rest);

      if (body === null) return null;

      return { status, headers: head, body };
    }

    const contentLength = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);

    if (rest.length < contentLength) return null;

    return { status, headers: head, body: rest.subarray(0, contentLength) };
  }

  function decodeChunks(body: Buffer): Buffer | null {
    let offset = 0;
    const chunks: Buffer[] = [];

    while (offset < body.length) {
      const lineEnd = body.indexOf("\r\n", offset);

      if (lineEnd === -1) return null;

      const sizeHex = body.subarray(offset, lineEnd).toString("latin1").split(";")[0].trim();
      const size = Number.parseInt(sizeHex, 16);

      if (Number.isNaN(size)) return null;

      offset = lineEnd + 2;

      if (size === 0) return Buffer.concat(chunks);

      if (body.length < offset + size + 2) return null;

      chunks.push(body.subarray(offset, offset + size));
      offset += size + 2;
    }

    return null;
  }

  /** Opens a tunneled socket and writes a raw HTTP/1.1 request to it. */
  async function request(host: TunnelHost, raw: string): Promise<Socket> {
    const client = await host.connect({ authority: "example.com:8080" });
    client.write(raw);
    return client;
  }

  it("carries a large response (bigger than the HTTP/2 flow-control window)", async () => {
    const payload = Buffer.alloc(256 * 1024, 0x41); // 256 KiB of 'A'

    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length });
      res.end(payload);
    };

    const { host, guest, transport, peers } = await setup();

    const client = await request(host, "GET /large HTTP/1.1\r\nHost: localhost\r\n\r\n");
    const response = await readResponse(client);

    expect(response.status).toBe(200);
    expect(response.body.length).toBe(payload.length);
    expect(response.body.equals(payload)).toBe(true);

    client.destroy();
    await host.close();
    await guest.close();
    for (const p of peers) p.destroy();
    await transport.close();
  });

  it("carries a large request body", async () => {
    const requestBody = Buffer.alloc(128 * 1024, 0x42); // 128 KiB of 'B'
    let received: Buffer = Buffer.alloc(0);

    handler = (req, res) => {
      req.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(String(received.length));
      });
    };

    const { host, guest, transport, peers } = await setup();

    const client = await request(host, `POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${requestBody.length}\r\n\r\n`);
    client.write(requestBody);

    const response = await readResponse(client);

    expect(response.status).toBe(200);
    expect(received.length).toBe(requestBody.length);
    expect(received.equals(requestBody)).toBe(true);

    client.destroy();
    await host.close();
    await guest.close();
    for (const p of peers) p.destroy();
    await transport.close();
  });

  it("streams a chunked response written in multiple writes", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });

      // Without Content-Length and with an explicit write per chunk, node emits
      // a chunked transfer-encoding response delivered across multiple frames.
      res.write("first");
      setImmediate(() => {
        res.write("-second");
        setImmediate(() => {
          res.end("-third");
        });
      });
    };

    const { host, guest, transport, peers } = await setup();

    const client = await request(host, "GET /chunked HTTP/1.1\r\nHost: localhost\r\n\r\n");
    const response = await readResponse(client);

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("first-second-third");

    client.destroy();
    await host.close();
    await guest.close();
    for (const p of peers) p.destroy();
    await transport.close();
  });

  it("carries binary data without corruption", async () => {
    // Every possible byte value, which would be mangled by any UTF-8/string path.
    const payload = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 256));

    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length });
      res.end(payload);
    };

    const { host, guest, transport, peers } = await setup();

    const client = await request(host, "GET /binary HTTP/1.1\r\nHost: localhost\r\n\r\n");
    const response = await readResponse(client);

    expect(response.body.equals(payload)).toBe(true);

    client.destroy();
    await host.close();
    await guest.close();
    for (const p of peers) p.destroy();
    await transport.close();
  });

  it("handles an empty response body", async () => {
    handler = (_req, res) => {
      res.writeHead(204, {});
      res.end();
    };

    const { host, guest, transport, peers } = await setup();

    const client = await request(host, "GET /empty HTTP/1.1\r\nHost: localhost\r\n\r\n");
    const response = await readResponse(client);

    expect(response.status).toBe(204);
    expect(response.body.length).toBe(0);

    client.destroy();
    await host.close();
    await guest.close();
    for (const p of peers) p.destroy();
    await transport.close();
  });

  it("serves multiple concurrent streams over a single connection", async () => {
    let active = 0;
    let maxActive = 0;

    handler = (_req, res) => {
      active += 1;
      maxActive = Math.max(maxActive, active);

      setTimeout(() => {
        active -= 1;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      }, 50);
    };

    const { host, guest, transport, peers } = await setup();

    const clients: Socket[] = [];
    const responses: Array<Promise<{ status: number; body: Buffer }>> = [];

    for (let i = 0; i < 8; i++) {
      const client = await host.connect({ authority: "example.com:8080" });
      clients.push(client);
      client.write(`GET /concurrent/${i} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
      responses.push(readResponse(client));
    }

    const results = await Promise.all(responses);

    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.toString()).toBe("ok");
    }

    // The target server actually saw overlapping requests.
    expect(maxActive).toBeGreaterThan(1);

    for (const c of clients) c.destroy();

    await host.close();
    await guest.close();
    for (const p of peers) p.destroy();
    await transport.close();
  });

  it("routes streams across a multi-connection pool", async () => {
    const seenBy: number[] = [];

    handler = (req, res) => {
      seenBy.push(Number(new URL(req.url ?? "/", targetUrl).pathname.split("/").pop()));
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    };

    const { host, guest, transport, peers } = await setup(3);

    const clients: Socket[] = [];

    for (let i = 0; i < 6; i++) {
      const client = await host.connect({ authority: "example.com:8080" });
      clients.push(client);
      client.write(`GET /multi/${i} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
      await readResponse(client);
    }

    expect(seenBy).toEqual([0, 1, 2, 3, 4, 5]);

    for (const c of clients) c.destroy();

    await host.close();
    await guest.close();
    for (const p of peers) p.destroy();
    await transport.close();
  });

  it("delivers a request body written in fragments by the client", async () => {
    let received = "";

    handler = (req, res) => {
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        received += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(received);
      });
    };

    const { host, guest, transport, peers } = await setup();

    const client = await host.connect({ authority: "example.com:8080" });
    client.write("POST /fragments HTTP/1.1\r\nHost: localhost\r\nContent-Length: 11\r\n\r\n");

    // Write the body in pieces with delays between them.
    client.write("one");
    await new Promise((r) => setTimeout(r, 10));
    client.write("two");
    await new Promise((r) => setTimeout(r, 10));
    client.write("three");

    const response = await readResponse(client);

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("onetwothree");

    client.destroy();
    await host.close();
    await guest.close();
    for (const p of peers) p.destroy();
    await transport.close();
  });

  // A client that half-closes (end its write side) immediately after writing
  // a request cannot get a response back: node's `http.createServer` treats
  // the incoming socket's FIN as end-of-connection and never writes the
  // response. This is a limitation of node's HTTP server (not the tunnel),
  // reproduced directly against a bare `http.createServer` + `emit("connection")`
  // socket without any tunnel involved.
  it.fails("carries a request sent then half-closed by the client", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("response-after-half-close");
    };

    const { host, guest, transport, peers } = await setup();

    const client = await host.connect({ authority: "example.com:8080" });
    const responsePromise = readResponse(client);

    client.write("GET /half-close HTTP/1.1\r\nHost: localhost\r\n\r\n");
    client.end();

    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("response-after-half-close");

    client.destroy();
    await host.close();
    await guest.close();
    for (const p of peers) p.destroy();
    await transport.close();
  });
});
