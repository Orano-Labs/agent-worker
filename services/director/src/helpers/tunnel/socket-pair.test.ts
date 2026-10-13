import { describe, expect, it } from "vitest";
import { SocketPair } from "./socket-pair";

describe("SocketPair", () => {
  it("creates a linked pair where data flows in both directions", async () => {
    const pairs = new SocketPair({ socketPath: `/tmp/socket-pair-test-${process.pid}.sock` });

    try {
      const { client, server } = await pairs.create();

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
    } finally {
      await pairs.close();
    }
  });

  it("matches concurrent pairs to the correct peers", async () => {
    const pairs = new SocketPair({ socketPath: `/tmp/socket-pair-test-${process.pid}.sock` });

    try {
      const [a, b] = await Promise.all([pairs.create(), pairs.create()]);

      const received = new Map<string, string[]>();
      for (const [name, socket] of [
        ["a-client", a.client],
        ["a-server", a.server],
        ["b-client", b.client],
        ["b-server", b.server],
      ] as const) {
        received.set(name, []);
        socket.on("data", (chunk) => received.get(name)?.push(chunk.toString()));
      }

      a.client.write("hello-a");
      b.client.write("hello-b");

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // The a-client's peer is a-server only, and b-client's peer is b-server only.
      expect(received.get("a-server")).toContain("hello-a");
      expect(received.get("b-server")).toContain("hello-b");
      expect(received.get("a-server")).not.toContain("hello-b");
      expect(received.get("b-server")).not.toContain("hello-a");

      for (const socket of [a.client, a.server, b.client, b.server]) {
        socket.destroy();
      }
    } finally {
      await pairs.close();
    }
  });

  it("does not leak identifier bytes into the consumer's stream", async () => {
    const pairs = new SocketPair({ socketPath: `/tmp/socket-pair-test-${process.pid}.sock` });

    try {
      const { client, server } = await pairs.create();

      const chunks: Buffer[] = [];
      server.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

      client.write("payload-after-identifier");

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const received = Buffer.concat(chunks).toString();
      // The 8-byte ID header must be fully consumed before handoff.
      expect(received).toBe("payload-after-identifier");

      client.destroy();
      server.destroy();
    } finally {
      await pairs.close();
    }
  });

  it("preserves bytes that arrive together with the identifier in order", async () => {
    const pairs = new SocketPair({ socketPath: `/tmp/socket-pair-test-${process.pid}.sock` });

    try {
      const { client, server } = await pairs.create();

      const chunks: Buffer[] = [];
      server.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

      // A single write larger than the identifier: the payload following the
      // 8-byte header must be delivered intact and in order.
      client.write("0123456789-after-header");

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(Buffer.concat(chunks).toString()).toBe("0123456789-after-header");

      client.destroy();
      server.destroy();
    } finally {
      await pairs.close();
    }
  });

  it("rejects create() when the client errors before the server side is accepted", async () => {
    const pairs = new SocketPair({ socketPath: `/tmp/socket-pair-test-${process.pid}.sock` });

    try {
      await pairs.ready();

      // Stop the server so the client's dial fails immediately, before any
      // server-side socket can be accepted.
      await pairs.close();

      await expect(pairs.create()).rejects.toThrow();
    } finally {
      await pairs.close();
    }
  });

  it("exposes its socket path and reports ready", async () => {
    const path = `/tmp/socket-pair-test-${process.pid}.sock`;
    const pairs = new SocketPair({ socketPath: path });

    try {
      await pairs.ready();
      expect(pairs.socketPath).toBe(path);
    } finally {
      await pairs.close();
    }
  });

  it("propagates destruction from client to server", async () => {
    const pairs = new SocketPair({ socketPath: `/tmp/socket-pair-test-${process.pid}.sock` });

    try {
      const { client, server } = await pairs.create();

      const serverClosed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for server to close")), 1000);
        server.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      client.destroy();
      await serverClosed;

      expect(server.destroyed).toBe(true);
    } finally {
      await pairs.close();
    }
  });

  it("propagates destruction from server to client", async () => {
    const pairs = new SocketPair({ socketPath: `/tmp/socket-pair-test-${process.pid}.sock` });

    try {
      const { client, server } = await pairs.create();

      const clientClosed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for client to close")), 1000);
        client.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      server.destroy();
      await clientClosed;

      expect(client.destroyed).toBe(true);
    } finally {
      await pairs.close();
    }
  });

  it("propagates an error with destruction across the socket pair", async () => {
    const pairs = new SocketPair({ socketPath: `/tmp/socket-pair-test-${process.pid}.sock` });

    try {
      const { client, server } = await pairs.create();

      client.on("error", () => {}); // Suppress client unhandled error
      server.on("error", () => {}); // Suppress server unhandled error

      const serverClosed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for server to close on error")), 1000);
        server.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      client.destroy(new Error("client-forced-failure"));
      await serverClosed;

      expect(server.destroyed).toBe(true);
    } finally {
      await pairs.close();
    }
  });

  it("does not cross-contaminate destruction between concurrent independent pairs", async () => {
    const pairs = new SocketPair({ socketPath: `/tmp/socket-pair-test-${process.pid}.sock` });

    try {
      const pairA = await pairs.create();
      const pairB = await pairs.create();

      // Destroy pair A completely
      pairA.client.destroy();

      await new Promise((r) => setTimeout(r, 50));

      // Pair B should remain completely unaffected and active
      expect(pairB.client.destroyed).toBe(false);
      expect(pairB.server.destroyed).toBe(false);

      pairB.client.destroy();
      pairB.server.destroy();
    } finally {
      await pairs.close();
    }
  });

  it("x", async () => {
    const pairs = new SocketPair({ socketPath: `/tmp/socket-pair-test-${process.pid}.sock` });
    const pair = await pairs.create();

    pair.server.end("ping");
    pair.client.end("pong");
  });
});
