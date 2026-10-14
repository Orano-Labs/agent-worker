import { connect } from "node:net";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { SocketPair } from "./socket-pair";

describe("SocketPair", () => {
  it("creates a linked pair where data flows in both directions", async () => {
    const pairs = new SocketPair();

    try {
      const { client, server } = await pairs.create();

      const received: string[] = [];
      client.on("data", (chunk) => received.push(chunk.toString()));
      server.on("data", (chunk) => received.push(chunk.toString()));

      client.write("client->server");
      server.write("server->client");

      await setTimeout(50);

      expect(received).toContain("client->server");
      expect(received).toContain("server->client");

      client.destroy();
      server.destroy();
    } finally {
      await pairs.close();
    }
  });

  it("matches concurrent pairs to the correct peers", async () => {
    const pairs = new SocketPair();

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

      await setTimeout(50);

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
    const pairs = new SocketPair();

    try {
      const { client, server } = await pairs.create();

      const chunks: Buffer[] = [];
      server.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

      client.write("payload-after-identifier");

      await setTimeout(50);

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
    const pairs = new SocketPair();

    try {
      const { client, server } = await pairs.create();

      const chunks: Buffer[] = [];
      server.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

      // A single write larger than the identifier: the payload following the
      // 8-byte header must be delivered intact and in order.
      client.write("0123456789-after-header");

      await setTimeout(50);

      expect(Buffer.concat(chunks).toString()).toBe("0123456789-after-header");

      client.destroy();
      server.destroy();
    } finally {
      await pairs.close();
    }
  });

  it("rejects create() when the client errors before the server side is accepted", async () => {
    const pairs = new SocketPair();

    await pairs.ready();

    // Stop the server so the client's dial fails immediately, before any
    // server-side socket can be accepted.
    await pairs.close();

    await expect(pairs.create()).rejects.toThrow();
  });

  it("exposes its socket path and reports ready", async () => {
    const path = `/tmp/socket-pair-test-${crypto.randomUUID()}.sock`;
    const pairs = new SocketPair({ path: path });

    try {
      await pairs.ready();
      expect(pairs.path).toBe(path);
    } finally {
      await pairs.close();
    }
  });

  it("transitions both sockets to the fully closed state after both sides end", async () => {
    const pairs = new SocketPair();

    try {
      const { client, server } = await pairs.create();

      client.on("error", () => {});
      server.on("error", () => {});

      client.end();

      await setTimeout(10);

      expect(server.readable).toBe(false);
      expect(server.writable).toBe(true);
      expect(client.writable).toBe(false);
      expect(client.readable).toBe(true);

      server.end();

      await setTimeout(10);

      expect(server.readable).toBe(false);
      expect(server.writable).toBe(false);
      expect(client.writable).toBe(false);
      expect(client.readable).toBe(false);

      expect(server.closed).toBe(true);
      expect(client.closed).toBe(true);

      client.destroy();
      server.destroy();
    } finally {
      await pairs.close();
    }
  });

  it("propagates server destruction to the client on write", async () => {
    const pairs = new SocketPair();

    try {
      const { client, server } = await pairs.create();

      client.on("error", () => {});
      server.on("error", () => {});

      expect(client.closed).toBe(false);
      expect(client.writable).toBe(true);
      expect(client.readable).toBe(true);

      server.destroy();

      await setTimeout(10);

      // Destroying one end does not synchronously destroy its peer.
      expect(client.closed).toBe(false);
      expect(client.writable).toBe(true);
      expect(client.readable).toBe(false);

      await new Promise((resolve) => client.write("", resolve));

      expect(client.closed).toBe(true);
      expect(client.writable).toBe(false);
      expect(client.readable).toBe(false);
      expect(client.errored).not.toBe(null);

      server.destroy();
      client.destroy();
    } finally {
      await pairs.close();
    }
  });

  it("does not cross-contaminate destruction between concurrent independent pairs", async () => {
    const pairs = new SocketPair();

    try {
      const pairA = await pairs.create();
      const pairB = await pairs.create();

      // Destroy pair A completely
      pairA.client.destroy();

      await setTimeout(50);

      // Pair B should remain completely unaffected and active
      expect(pairB.client.destroyed).toBe(false);
      expect(pairB.server.destroyed).toBe(false);

      pairB.client.destroy();
      pairB.server.destroy();
      pairA.server.destroy();
      pairA.client.destroy();
    } finally {
      await pairs.close();
    }
  });

  it("continues forwarding in the reverse direction after one side half-closes", async () => {
    const pairs = new SocketPair();

    try {
      const { client, server } = await pairs.create();

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
    } finally {
      await pairs.close();
    }
  });

  it("propagates client destruction to the server on write", async () => {
    const pairs = new SocketPair();

    try {
      const { client, server } = await pairs.create();

      client.on("error", () => {});
      server.on("error", () => {});

      const serverEnded = new Promise<void>((resolve) => server.once("end", resolve));
      server.resume();
      client.destroy();

      await serverEnded;

      expect(client.closed).toBe(true);
      expect(client.writable).toBe(false);
      expect(client.readable).toBe(false);
      expect(server.closed).toBe(false);
      expect(server.writable).toBe(true);
      expect(server.readable).toBe(false);

      const writeError = await new Promise<Error | null>((resolve) => server.write("", (error) => resolve(error ?? null)));

      expect(writeError).toBeInstanceOf(Error);
      expect(server.closed).toBe(true);
      expect(server.writable).toBe(false);
      expect(server.readable).toBe(false);
      expect(server.errored).not.toBe(null);
    } finally {
      await pairs.close();
    }
  });

  it("drops foreign connections that use an unknown identifier", async () => {
    const pairs = new SocketPair();

    try {
      await pairs.ready();

      const foreign = connect({ path: pairs.path });
      foreign.on("error", () => {});
      const foreignClosed = new Promise<void>((resolve) => foreign.once("close", resolve));

      // A full eight-byte header with an identifier for which no create()
      // waiter exists must be dropped without disrupting the socket server.
      foreign.write(Buffer.alloc(SocketPair.ID_BYTES, 0xff));
      await foreignClosed;

      const { client, server } = await pairs.create();

      const received = new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        server.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
          resolve(Buffer.concat(chunks));
        });
      });

      client.write("valid-after-foreign");
      expect((await received).toString()).toBe("valid-after-foreign");

      client.destroy();
      server.destroy();
    } finally {
      await pairs.close();
    }
  });

  it("destroys live accepted sockets when close times out and rejects later creates", async () => {
    const pairs = new SocketPair();

    const { client, server } = await pairs.create();

    client.on("error", () => {});
    server.on("error", () => {});

    await pairs.close(10);
    await setTimeout(10);

    console.log(pairs.connections);

    expect(pairs.connections).toBe(0);
    expect(server.destroyed).toBe(true);
    expect(client.destroyed).toBe(true);

    await expect(pairs.create()).rejects.toThrow();
  });
});
