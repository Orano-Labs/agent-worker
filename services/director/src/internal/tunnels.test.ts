import { createServer as createHttp2Server, type ServerHttp2Stream } from "node:http2";
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
  connect: () => Promise<void>;
  close: () => Promise<void>;
};

const createHarness = async (initialSession = true, tunnels?: Tunnels): Promise<Harness> => {
  let pings = 0;
  const authorities: string[] = [];

  const http2Server = createHttp2Server({
    settings: {
      enableConnectProtocol: true,
      maxConcurrentStreams: 1_000,
    },
  });

  http2Server.on("session", (session) => {
    session.on("ping", () => {
      pings += 1;
    });
  });

  http2Server.on("stream", (stream: ServerHttp2Stream, headers) => {
    authorities.push(String(headers[":authority"]));

    stream.respond({ ":status": 200 });
    stream.on("data", (chunk) => stream.write(chunk));
  });

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
  const tunnel = tunnels ? tunnels.ensure("supervisor-1") : new Tunnels.Tunnel({ logger: createLogger() });

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
    const closing = tunnels.close("supervisor-1");
    const second = tunnels.ensure("supervisor-1");

    expect(second).not.toBe(first);

    await closing;
    await tunnels[Container.SymbolDispose]();
  });

  it("tracks online supervisors and emits pool events", async () => {
    const tunnels = new Tunnels(createLogger());
    const online: string[] = [];
    const offline: string[] = [];

    tunnels.on("online", (id) => {
      online.push(id);
    });
    tunnels.on("offline", (id) => {
      offline.push(id);
    });

    harness = await createHarness(false, tunnels);

    expect([...tunnels.iterator()]).toEqual([]);

    await harness.connect();

    expect([...tunnels.iterator()].map(([id]) => id)).toEqual(["supervisor-1"]);
    expect(online).toEqual(["supervisor-1"]);

    await tunnels.close("supervisor-1");

    expect([...tunnels.iterator()]).toEqual([]);
    expect(offline).toEqual(["supervisor-1"]);

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

  it("tracks online state and emits changes", async () => {
    harness = await createHarness(false);

    const states: boolean[] = [];

    harness.tunnel.on("online", (online) => {
      states.push(online);
    });

    expect(harness.tunnel.online).toBe(false);

    await harness.connect();

    expect(harness.tunnel.online).toBe(true);
    expect(states).toEqual([true]);

    await harness.tunnel.close();

    expect(harness.tunnel.online).toBe(false);
    expect(states).toEqual([true, false]);
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
