import { createServer as createHttpServer } from "node:http";
import { connect } from "node:http2";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SocketPair } from "./socket-pair";
import { TunnelGuest } from "./tunnel-guest";
import { TunnelHost } from "./tunnel-host";

describe("TunnelGuest", () => {
  let targetServer: ReturnType<typeof createHttpServer>;
  let targetUrl: string;

  beforeEach(async () => {
    targetServer = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    await new Promise<void>((resolve) => targetServer.listen(0, resolve));

    const address = targetServer.address() as { port: number };
    targetUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  });

  /**
   * A transport backed by a `SocketPair` that pairs each guest-dialed socket
   * with a peer the test can hand to a `TunnelHost` (or otherwise dispose of).
   */
  class Transport {
    readonly pairs: SocketPair;
    readonly peers: Socket[] = [];
    readonly dialed: Socket[] = [];

    constructor(tag: string) {
      this.pairs = new SocketPair({ socketPath: join(tmpdir(), `guest-transport-${tag}-${process.pid}.sock`) });
    }

    /** Used as `TunnelGuest`'s `createConnection`. */
    async createConnection() {
      const pair = await this.pairs.create();
      this.dialed.push(pair.client);
      this.peers.push(pair.server);
      return pair.client;
    }

    /** Destroys any peer sockets the test did not consume. */
    destroyUnconsumed() {
      for (const peer of this.peers) {
        if (!peer.destroyed) {
          peer.destroy();
        }
      }
    }

    async close() {
      this.destroyUnconsumed();
      await this.pairs.close();
    }
  }

  async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for condition");
      }

      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Reads a complete HTTP/1.1 response (Content-Length or chunked) off a socket. */
  function readHttpResponse(socket: Socket): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);

      const finish = () => {
        socket.off("data", onData);
        socket.off("error", onError);

        const headerEnd = buffer.indexOf("\r\n\r\n");

        if (headerEnd === -1) {
          reject(new Error("No HTTP response received"));
          return;
        }

        const head = buffer.subarray(0, headerEnd).toString("latin1");
        const status = Number(head.split(" ")[1]);
        const rest = buffer.subarray(headerEnd + 4);

        if (/chunked/i.test(head)) {
          const body = decodeChunked(rest);

          if (body === null) {
            reject(new Error("Incomplete chunked body"));
            return;
          }

          resolve({ status, body });
          return;
        }

        const contentLength = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
        resolve({ status, body: rest.subarray(0, contentLength).toString("latin1") });
      };

      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

        const headerEnd = buffer.indexOf("\r\n\r\n");

        if (headerEnd === -1) return;

        const head = buffer.subarray(0, headerEnd).toString("latin1");

        if (/chunked/i.test(head)) {
          if (decodeChunked(buffer.subarray(headerEnd + 4)) !== null) {
            finish();
          }
          return;
        }

        const contentLength = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);

        if (buffer.length >= headerEnd + 4 + contentLength) {
          finish();
        }
      };

      const onError = (error: Error) => {
        socket.off("data", onData);
        reject(error);
      };

      socket.on("data", onData);
      socket.once("error", onError);
    });
  }

  function decodeChunked(body: Buffer): string | null {
    let offset = 0;
    let out = "";

    while (offset < body.length) {
      const lineEnd = body.indexOf("\r\n", offset);

      if (lineEnd === -1) return null;

      const sizeHex = body.subarray(offset, lineEnd).toString("latin1").split(";")[0].trim();
      const size = Number.parseInt(sizeHex, 16);

      if (Number.isNaN(size)) return null;

      offset = lineEnd + 2;

      if (size === 0) return out;

      if (body.length < offset + size + 2) return null;

      out += body.subarray(offset, offset + size).toString("latin1");
      offset += size + 2;
    }

    return null;
  }

  describe("connection pool", () => {
    it("establishes maxConnections transport sockets on construction", async () => {
      const transport = new Transport("pool");

      const guest = new TunnelGuest({
        maxConnections: 3,
        router: () => new URL(targetUrl),
        createConnection: () => transport.createConnection(),
      });

      await waitUntil(() => transport.dialed.length === 3);

      expect(transport.dialed.length).toBe(3);

      await guest.close();
      await transport.close();
    });

    it("re-establishes a dropped connection until close()", async () => {
      const transport = new Transport("reconnect");

      const guest = new TunnelGuest({
        maxConnections: 1,
        router: () => new URL(targetUrl),
        createConnection: () => transport.createConnection(),
      });

      await waitUntil(() => transport.dialed.length === 1);

      // Drop the connection; the guest should dial a replacement.
      transport.dialed[0].destroy();

      await waitUntil(() => transport.dialed.length >= 2);

      expect(transport.dialed.length).toBeGreaterThanOrEqual(2);

      await guest.close();
      await transport.close();
    });

    it("stops reconnecting after close()", async () => {
      const transport = new Transport("stop");

      const guest = new TunnelGuest({
        maxConnections: 1,
        router: () => new URL(targetUrl),
        createConnection: () => transport.createConnection(),
      });

      await waitUntil(() => transport.dialed.length === 1);

      // Drop the connection to put the maintainer into its reconnect wait,
      // then close: the maintainer must give up rather than dialing again.
      transport.dialed[0].destroy();

      await guest.close();

      const countAfterClose = transport.dialed.length;

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(transport.dialed.length).toBe(countAfterClose);

      await transport.close();
    });
  });

  describe("stream routing", () => {
    it("routes a stream through the proxy to a guest target", async () => {
      const transport = new Transport("route");

      const guest = new TunnelGuest({
        maxConnections: 1,
        router: () => new URL(targetUrl),
        createConnection: () => transport.createConnection(),
      });

      await waitUntil(() => transport.dialed.length === 1);

      const host = new TunnelHost({ socketPath: join(tmpdir(), `guest-host-${process.pid}.sock`) });
      await host.upgrade(transport.peers[0]);

      const client = await host.connect({ authority: "example.com:8080" });

      client.write("GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\n");

      const response = await readHttpResponse(client);

      expect(response.status).toBe(200);
      expect(response.body).toBe("ok");

      client.destroy();
      await host.close();
      await guest.close();
      await transport.close();
    });

    it("rejects non-CONNECT streams with 405", async () => {
      const transport = new Transport("nonconnect");

      const guest = new TunnelGuest({
        maxConnections: 1,
        router: () => new URL(targetUrl),
        createConnection: () => transport.createConnection(),
      });

      await waitUntil(() => transport.dialed.length === 1);

      // Drive a raw HTTP/2 client against the transport peer to issue a
      // non-CONNECT stream.
      const session = connect("http://localhost:1", { createConnection: () => transport.peers[0] });
      await new Promise<void>((resolve, reject) => {
        session.once("connect", resolve);
        session.once("error", reject);
      });

      const stream = session.request({ ":method": "GET", ":path": "/" });

      const headers = await new Promise<Record<string, string | string[]>>((resolve) => {
        stream.once("response", resolve);
      });

      expect(headers[":status"]).toBe(405);

      stream.close();
      session.close();
      await guest.close();
      await transport.close();
    });
  });
});
