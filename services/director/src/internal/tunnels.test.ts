import { createServer as createHttp2Server, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { connect, createServer as createNetServer, Socket } from "node:net";
import { Container } from "@aw/container";
import { Logger } from "@aw/logging";
import { afterEach, describe, expect, it } from "vitest";
import { Tunnels } from "@/internal/tunnels";

const createLogger = () => {
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    namespace() {
      return logger;
    },
    binding() {
      return logger;
    },
  };

  return logger as unknown as Logger;
};

type Harness = {
  tunnel: Tunnels.Tunnel;
  http2Server: ReturnType<typeof createHttp2Server>;
  netServer: ReturnType<typeof createNetServer>;
  pings: number;
  authorities: string[];
  serverSessions: ServerHttp2Session[];
  sessionStreamCounts: number[];
  connect: () => Promise<void>;
  close: () => Promise<void>;
};

const createHarness = async (initialSession = true, tunnels?: Tunnels, closeTimeoutMs = 50): Promise<Harness> => {
  let pings = 0;
  const authorities: string[] = [];
  const serverSessions: ServerHttp2Session[] = [];
  const sessionStreamCounts: number[] = [];

  const http2Server = createHttp2Server({
    settings: {
      enableConnectProtocol: true,
      maxConcurrentStreams: 1_000,
    },
  });

  http2Server.on("session", (session) => {
    const index = serverSessions.length;

    serverSessions.push(session);
    sessionStreamCounts.push(0);

    session.on("stream", () => {
      sessionStreamCounts[index] += 1;
    });

    session.on("ping", () => {
      pings += 1;
    });
  });

  http2Server.on("stream", (stream: ServerHttp2Stream, headers) => {
    const authority = String(headers[":authority"]);
    authorities.push(authority);

    stream.on("error", () => {});

    if (authority === "reject") {
      stream.respond({ ":status": 502 });
      stream.end();

      return;
    }

    if (authority === "hang") {
      return;
    }

    stream.respond({ ":status": 200 });
    stream.on("data", (chunk) => stream.write(chunk));
  });
  http2Server.on("sessionError", () => {});

  const netServer = createNetServer();
  const pendingSockets: Array<(socket: Socket) => void> = [];

  netServer.on("connection", (socket) => {
    const resolve = pendingSockets.shift();

    if (resolve) {
      resolve(socket);
    }
  });

  await new Promise<void>((resolve) => {
    netServer.listen(0, "127.0.0.1", resolve);
  });

  const address = netServer.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address");
  }

  const sockets: Socket[] = [];
  const tunnel = tunnels ? tunnels.ensure("supervisor-1") : new Tunnels.Tunnel({ logger: createLogger(), closeTimeoutMs });

  const connectSession = async () => {
    const serverSocket = new Promise<Socket>((resolve) => {
      pendingSockets.push(resolve);
    });

    const clientSocket = connect(address.port, "127.0.0.1");
    const server = await serverSocket;

    sockets.push(clientSocket, server);

    http2Server.emit("connection", server);

    await tunnel.upgrade(clientSocket);
  };

  if (initialSession) {
    await connectSession();
  }

  return {
    tunnel,
    http2Server,
    netServer,
    get pings() {
      return pings;
    },
    authorities,
    serverSessions,
    sessionStreamCounts,
    connect: connectSession,
    close: async () => {
      await tunnel.close();

      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => http2Server.close(() => resolve()));
      await new Promise<void>((resolve) => netServer.close(() => resolve()));
    },
  };
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeout = 1_000) => {
  const started = Date.now();

  while (!predicate()) {
    if (Date.now() - started >= timeout) {
      throw new Error("Timed out waiting for condition.");
    }

    await wait(10);
  }
};

describe("Tunnels", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("gets or creates a tunnel by id", async () => {
    const tunnels = new Tunnels(createLogger());
    const first = tunnels.ensure("supervisor-1");

    expect(tunnels.ensure("supervisor-1")).toBe(first);
    expect(tunnels.ensure("supervisor-2")).not.toBe(first);

    await tunnels[Container.SymbolDispose]();

    expect(() => tunnels.ensure("supervisor-1")).toThrow();
  });

  it("frees the id as soon as a tunnel starts closing", async () => {
    const tunnels = new Tunnels(createLogger());
    const first = tunnels.ensure("supervisor-1");
    const closing = first.close();
    const second = tunnels.ensure("supervisor-1");

    expect(second).not.toBe(first);

    await closing;
    await tunnels[Container.SymbolDispose]();
  });

  it("tracks online supervisors", async () => {
    const tunnels = new Tunnels(createLogger());

    harness = await createHarness(false, tunnels);

    expect(tunnels.get("supervisor-1")).toBe(harness.tunnel);
    expect([...tunnels.iterator()]).toEqual([]);

    await harness.connect();

    expect([...tunnels.iterator()].map(([id]) => id)).toEqual(["supervisor-1"]);

    await harness.tunnel.close();

    expect([...tunnels.iterator()]).toEqual([]);
    expect(tunnels.get("supervisor-1")).toBeUndefined();

    await tunnels[Container.SymbolDispose]();
  });
});

describe("Tunnels.Tunnel", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("registers a session from an upgraded socket", async () => {
    harness = await createHarness();

    expect(harness.tunnel.sessions).toBe(1);
    expect(harness.tunnel.connections).toBe(0);
  });

  it("tracks online state", async () => {
    harness = await createHarness(false);

    expect(harness.tunnel.online).toBe(false);

    await harness.connect();

    expect(harness.tunnel.online).toBe(true);

    await harness.tunnel.close();

    expect(harness.tunnel.online).toBe(false);
  });

  it("opens a CONNECT stream and tracks active connections", async () => {
    harness = await createHarness();

    const stream = await harness.tunnel.stream({
      authority: "example.com:80",
      path: "/",
    });

    expect(harness.tunnel.connections).toBe(1);

    stream.write("hello");

    const received = await new Promise<string>((resolve) => {
      stream.once("data", (chunk) => resolve(chunk.toString()));
    });

    expect(received).toBe("hello");

    stream.close();

    await new Promise<void>((resolve) => stream.once("close", () => resolve()));

    expect(harness.tunnel.connections).toBe(0);
  });

  it("opens a request on an available session", async () => {
    harness = await createHarness();

    const request = await harness.tunnel.request(
      {
        ":method": "GET",
        ":path": "/request",
        ":authority": "example.com",
      },
      { endStream: true },
    );

    expect(request.closed).toBe(false);

    await new Promise<void>((resolve) => {
      request.once("close", () => resolve());
      request.close();
    });
  });

  it("rejects requests when no session is available or the tunnel is closed", async () => {
    const tunnel = new Tunnels.Tunnel({ logger: createLogger() });
    const headers = {
      ":method": "GET",
      ":path": "/",
      ":authority": "example.com",
    };

    await expect(tunnel.request(headers)).rejects.toThrow("No available tunnel session");

    await tunnel.close();

    await expect(tunnel.request(headers)).rejects.toThrow("Tunnel is closed");
  });

  it("queues streams until a session becomes available", async () => {
    harness = await createHarness(false);

    let settled = false;
    const pending = harness.tunnel.stream({
      authority: "example.com:80",
      path: "/queued",
    });

    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await wait(50);

    expect(settled).toBe(false);
    expect(harness.tunnel.queue).toBe(1);

    await harness.connect();

    const stream = await pending;

    expect(settled).toBe(true);
    expect(harness.tunnel.queue).toBe(0);
    expect(harness.tunnel.connections).toBe(1);

    stream.close();
  });

  it("rejects queued streams after the queue timeout", async () => {
    const tunnel = new Tunnels.Tunnel({ logger: createLogger() });

    await expect(
      tunnel.stream({
        authority: "example.com:80",
        timeout: 25,
      }),
    ).rejects.toThrow("Timed out waiting for an available tunnel stream slot.");

    expect(tunnel.queue).toBe(0);

    await tunnel.close();
  });

  it("rejects a stream when the CONNECT request is refused", async () => {
    harness = await createHarness();

    const tunnel = harness.tunnel;

    await expect(
      tunnel.stream({
        authority: "reject",
      }),
    ).rejects.toThrow("HTTP/2 CONNECT failed with status 502");

    await waitFor(() => tunnel.connections === 0);
  });

  it("rejects a stream when establishment times out", async () => {
    harness = await createHarness();

    const tunnel = harness.tunnel;

    await expect(
      tunnel.stream({
        authority: "hang",
        timeout: 25,
      }),
    ).rejects.toThrow("HTTP/2 stream timed out before the tunnel was established");

    await waitFor(() => tunnel.connections === 0);
    expect(tunnel.queue).toBe(0);
  });

  it("dispatches queued streams by priority", async () => {
    harness = await createHarness(false);

    const low = harness.tunnel.stream({
      authority: "low",
      path: "/",
      priority: 1,
    });
    const high = harness.tunnel.stream({
      authority: "high",
      path: "/",
      priority: 10,
    });
    const normal = harness.tunnel.stream({
      authority: "normal",
      path: "/",
    });

    await wait(10);

    expect(harness.tunnel.queue).toBe(3);

    await harness.connect();

    const streams = await Promise.all([low, high, normal]);

    expect(harness.authorities).toEqual(["high", "low", "normal"]);

    for (const stream of streams) {
      stream.close();
    }
  });

  it("limits each session to 128 concurrent streams", async () => {
    harness = await createHarness();

    const tunnel = harness.tunnel;
    const streams = await Promise.all(
      Array.from({ length: 128 }, (_, index) => {
        return tunnel.stream({
          authority: "example.com:80",
          path: `/${index}`,
        });
      }),
    );

    expect(harness.tunnel.connections).toBe(128);

    let settled = false;
    const pending = harness.tunnel.stream({
      authority: "example.com:80",
      path: "/queued",
    });

    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await wait(50);

    expect(settled).toBe(false);

    streams[0].close();

    const extra = await pending;

    expect(settled).toBe(true);
    expect(harness.tunnel.connections).toBe(128);

    extra.close();
  });

  it("distributes streams across sessions", async () => {
    harness = await createHarness();

    await harness.connect();

    expect(harness.tunnel.sessions).toBe(2);

    const first = await harness.tunnel.stream({
      authority: "first",
      path: "/",
    });
    const second = await harness.tunnel.stream({
      authority: "second",
      path: "/",
    });

    expect(harness.sessionStreamCounts).toEqual([1, 1]);

    first.close();
    second.close();
  });

  it("drains an active stream and removes the session after GOAWAY", async () => {
    harness = await createHarness();

    const tunnel = harness.tunnel;
    const stream = await tunnel.stream({
      authority: "example.com:80",
      path: "/",
    });

    harness.serverSessions[0].goaway();

    await waitFor(() => !tunnel.online);
    expect(tunnel.online).toBe(false);
    expect(tunnel.sessions).toBe(1);

    stream.write("still-open");

    const received = await new Promise<string>((resolve) => {
      stream.once("data", (chunk) => resolve(chunk.toString()));
    });

    expect(received).toBe("still-open");

    const closed = new Promise<void>((resolve) => stream.once("close", () => resolve()));

    stream.close();
    await closed;
    await waitFor(() => tunnel.sessions === 0);
  });

  it("queues new streams after GOAWAY until another session connects", async () => {
    harness = await createHarness();

    const tunnel = harness.tunnel;

    harness.serverSessions[0].goaway();

    await waitFor(() => !tunnel.online);

    const pending = tunnel.stream({
      authority: "queued",
      path: "/",
      timeout: 1_000,
    });

    await wait(10);

    expect(tunnel.queue).toBe(1);

    await harness.connect();

    const stream = await pending;

    expect(tunnel.queue).toBe(0);
    expect(tunnel.connections).toBe(1);

    stream.close();
  });

  it("force destroys sessions when graceful close times out", async () => {
    harness = await createHarness(true, undefined, 20);

    // Use a raw request so closing the tunnel does not abort the stream through the tunnel signal.
    const stream = await harness.tunnel.request(
      {
        ":method": "GET",
        ":path": "/",
        ":authority": "example.com:80",
      },
      { endStream: false },
    );
    stream.on("error", () => {});

    const streamClosed = new Promise<void>((resolve) => stream.once("close", () => resolve()));

    const started = Date.now();

    await harness.tunnel.close();

    expect(Date.now() - started).toBeGreaterThanOrEqual(10);

    await streamClosed;

    expect(stream.destroyed).toBe(true);
  });

  it("rejects queued streams when the tunnel closes", async () => {
    const tunnel = new Tunnels.Tunnel({ logger: createLogger() });
    const expectation = expect(
      tunnel.stream({
        authority: "example.com:80",
      }),
    ).rejects.toThrow("Tunnel is closed");

    await tunnel.close();

    await expectation;
  });

  it("rejects queued streams with the close reason and is idempotent", async () => {
    const tunnel = new Tunnels.Tunnel({ logger: createLogger() });
    const reason = new Error("Tunnel is shutting down");
    const expectation = expect(
      tunnel.stream({
        authority: "example.com:80",
      }),
    ).rejects.toThrow("Tunnel is shutting down");

    await tunnel.close(reason);

    await expectation;

    expect(tunnel.closed).toBe(true);
    await expect(tunnel.close()).resolves.toBeUndefined();
  });

  it("rejects upgrades and streams after the tunnel closes", async () => {
    const tunnel = new Tunnels.Tunnel({ logger: createLogger() });

    await tunnel.close();

    await expect(
      tunnel.stream({
        authority: "example.com:80",
      }),
    ).rejects.toThrow();

    await expect(tunnel.upgrade(new Socket())).rejects.toThrow();
  });
});
