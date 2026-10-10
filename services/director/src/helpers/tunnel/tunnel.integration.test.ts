import { connect } from "node:http2";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SocketPair } from "./socket-pair";
import { TunnelGuest } from "./tunnel-guest";
import { TunnelHost } from "./tunnel-host";

/**
 * End-to-end tests that drive a real `TunnelGuest` + `TunnelHost` pair against
 * the public echo server at https://testserver.host.
 *
 * The guest routes every tunneled request to the echo server, so the response
 * echoes back the request path, query string, headers, and body — letting us
 * assert the tunnel carries real HTTP traffic faithfully in both directions.
 *
 * These tests hit a public endpoint and are therefore skipped by default. Run
 * them explicitly with:
 *
 *   RUN_TUNNEL_INTEGRATION=1 pnpm test
 */

const TARGET = "http://testserver.host";

describe.skipIf(process.env.RUN_TUNNEL_INTEGRATION !== "1")("Tunnel e2e (testserver.host)", { timeout: 30000 }, () => {
  let transport: SocketPair;
  let peers: Socket[];
  let guest: TunnelGuest;
  let host: TunnelHost;

  beforeEach(async () => {
    transport = new SocketPair({ socketPath: join(tmpdir(), `tunnel-e2e-${process.pid}.sock`) });
    peers = [];

    guest = new TunnelGuest({
      maxConnections: 1,
      router: () => new URL(TARGET),
      createConnection: async () => {
        const pair = await transport.create();
        peers.push(pair.server);
        return pair.client;
      },
    });

    await waitUntil(() => peers.length === 1);

    host = new TunnelHost({ socketPath: join(tmpdir(), `tunnel-e2e-host-${process.pid}.sock`) });
    await host.upgrade(peers[0]);
  });

  afterEach(async () => {
    await host.close();
    await guest.close();

    for (const peer of peers) {
      if (!peer.destroyed) {
        peer.destroy();
      }
    }

    await transport.close();
  });

  async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for condition");
      }

      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Writes an HTTP/1.1 request and collects the complete raw response. */
  async function send(socket: Socket, request: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let buffer = "";

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for response; got: ${JSON.stringify(buffer.slice(0, 500))}`));
      }, 15000);

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("latin1");

        if (isComplete(buffer)) {
          cleanup();
          resolve(buffer);
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

      socket.write(request);
    });
  }

  function isComplete(buffer: string): boolean {
    const headerEnd = buffer.indexOf("\r\n\r\n");

    if (headerEnd === -1) return false;

    const head = buffer.slice(0, headerEnd);

    if (/transfer-encoding:\s*chunked/i.test(head)) {
      return buffer.endsWith("0\r\n\r\n");
    }

    const contentLength = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);

    return buffer.length >= headerEnd + 4 + contentLength;
  }

  /** Extracts the response body (de-chunked if necessary). */
  function bodyOf(raw: string): string {
    const headerEnd = raw.indexOf("\r\n\r\n");
    const head = raw.slice(0, headerEnd);
    const rest = raw.slice(headerEnd + 4);

    if (/transfer-encoding:\s*chunked/i.test(head)) {
      return dechunk(rest);
    }

    const contentLength = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? rest.length);

    return rest.slice(0, contentLength);
  }

  function dechunk(body: string): string {
    let offset = 0;
    let out = "";

    while (offset < body.length) {
      const lineEnd = body.indexOf("\r\n", offset);

      if (lineEnd === -1) break;

      const sizeHex = body.slice(offset, lineEnd).split(";")[0].trim();
      const size = Number.parseInt(sizeHex, 16);

      if (Number.isNaN(size) || size === 0) break;

      offset = lineEnd + 2;
      out += body.slice(offset, offset + size);
      offset += size + 2;
    }

    return out;
  }

  it("carries a GET request and echoes the query string", async () => {
    const client = await host.connect({ authority: "testserver.host" });

    const raw = await send(client, "GET /get?a=1&b=2 HTTP/1.1\r\nHost: testserver.host\r\n\r\n");

    const body = JSON.parse(bodyOf(raw));
    expect(body.url).toBe("http://testserver.host/get?a=1&b=2");
    expect(body.args).toEqual({ a: "1", b: "2" });

    client.destroy();
  });

  it("carries a POST body in both directions", async () => {
    const client = await host.connect({ authority: "testserver.host" });

    const payload = JSON.stringify({ hello: "tunnel", n: 42 });
    const raw = await send(
      client,
      `POST /anything HTTP/1.1\r\nHost: testserver.host\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );

    const body = JSON.parse(bodyOf(raw));
    expect(body.method).toBe("POST");
    expect(body.data).toBe(payload);
    expect(body.json).toEqual({ hello: "tunnel", n: 42 });

    client.destroy();
  });

  it("forwards custom request headers to the target", async () => {
    const client = await host.connect({ authority: "testserver.host" });

    const raw = await send(client, "GET /anything HTTP/1.1\r\nHost: testserver.host\r\nX-Custom-Header: tunnel-value\r\n\r\n");

    const body = JSON.parse(bodyOf(raw));
    expect(body.headers["X-Custom-Header"]).toBe("tunnel-value");

    client.destroy();
  });

  it("streams a structured JSON response", async () => {
    const client = await host.connect({ authority: "testserver.host" });

    const raw = await send(client, "GET /json HTTP/1.1\r\nHost: testserver.host\r\n\r\n");

    const body = JSON.parse(bodyOf(raw));
    expect(body.slideshow).toBeDefined();

    client.destroy();
  });

  it("rejects non-CONNECT streams with 405 at the guest", async () => {
    // A dedicated guest whose transport is driven directly by an HTTP/2
    // client, so we can issue an arbitrary non-CONNECT stream.
    const nonConnectTransport = new SocketPair({ socketPath: join(tmpdir(), `tunnel-nc-${process.pid}.sock`) });
    const nonConnectPeers: Socket[] = [];

    const nonConnectGuest = new TunnelGuest({
      maxConnections: 1,
      router: () => new URL(TARGET),
      createConnection: async () => {
        const pair = await nonConnectTransport.create();
        nonConnectPeers.push(pair.server);
        return pair.client;
      },
    });

    await waitUntil(() => nonConnectPeers.length === 1);

    const session = connect("http://localhost:1", { createConnection: () => nonConnectPeers[0] });
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
    await nonConnectGuest.close();

    for (const peer of nonConnectPeers) {
      if (!peer.destroyed) peer.destroy();
    }

    await nonConnectTransport.close();
  });
});
