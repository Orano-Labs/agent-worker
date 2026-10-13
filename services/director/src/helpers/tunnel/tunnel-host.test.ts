import {
  type ClientHttp2Session,
  connect,
  constants,
  createServer,
  type Http2SessionEventMap,
  type Http2Stream,
  type ServerHttp2Stream,
} from "node:http2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SocketPair } from "./socket-pair";
import { TunnelHost } from "./tunnel-host";

describe("TunnelHost.Session", () => {
  const socketPairs = new SocketPair();

  let http2Server: ReturnType<typeof createServer>;
  let http2Session: ClientHttp2Session;
  let http2Streams: Map<Http2Stream, Http2SessionEventMap["stream"]>;

  beforeEach(async () => {
    http2Server = createServer();
    http2Streams = new Map();

    http2Server.on("stream", (...args) => {
      http2Streams.set(args[0], args);
    });

    const sockets = await socketPairs.create();

    http2Server.emit("connection", sockets.server);

    http2Session = connect("http://localhost:8000", {
      createConnection: () => sockets.client,
    });

    await new Promise<void>((resolve, reject) => {
      http2Session.once("connect", () => resolve());
      http2Session.once("error", reject);
    });
  });

  afterEach(async () => {
    for (const [stream] of http2Streams) {
      stream.close(constants.NGHTTP2_NO_ERROR);
    }

    http2Session.destroy();

    await new Promise<void>((resolve) => http2Server.close(() => resolve()));
  });

  describe("state and lifecycle", () => {
    it("starts in the open state with no active streams", () => {
      const session = new TunnelHost.Session(http2Session);

      expect(session.state).toBe("open");
      expect(session.activeStreamCount).toBe(0);
      expect(session.closed).toBe(false);
      expect(session.destroyed).toBe(false);
    });

    it("transitions to error state when the raw session emits an error", () => {
      const session = new TunnelHost.Session(http2Session);

      http2Session.emit("error", new Error("boom"));

      expect(session.state).toBe("error");
    });

    it("destroy() is idempotent and marks the session destroyed", () => {
      const session = new TunnelHost.Session(http2Session);

      session.destroy(new Error("shutdown"));
      session.destroy(new Error("again"));

      expect(session.destroyed).toBe(true);
      expect(session.state).toBe("error");
    });

    it("close() resolves once the raw session is closed", async () => {
      const session = new TunnelHost.Session(http2Session);

      await session.close();

      expect(session.closed).toBe(true);
      expect(session.state).toBe("closed");
    });
  });

  describe("request()", () => {
    it("returns a stream and tracks it as an active stream", () => {
      const session = new TunnelHost.Session(http2Session);

      session.request({ ":method": "GET", ":path": "/" });
      session.request({ ":method": "GET", ":path": "/" });

      expect(session.activeStreamCount).toBe(2);
    });

    it("decrements the active stream count when the stream closes", async () => {
      const session = new TunnelHost.Session(http2Session);

      const stream1 = session.request({ ":method": "GET", ":path": "/" });
      const stream2 = session.request({ ":method": "GET", ":path": "/" });

      expect(session.activeStreamCount).toBe(2);

      stream1.close(constants.NGHTTP2_NO_ERROR);
      stream2.close(constants.NGHTTP2_NO_ERROR);

      await Promise.all([
        new Promise<void>((resolve) => stream1.once("close", resolve)),
        new Promise<void>((resolve) => stream2.once("close", resolve)),
      ]);

      expect(session.activeStreamCount).toBe(0);
    });

    it("rejects new streams once a GOAWAY has been received", async () => {
      const session = new TunnelHost.Session(http2Session);

      // Keep one stream open so the session lingers in the draining state.
      const existing = session.request({ ":method": "GET", ":path": "/" });

      // Simulate the peer gracefully draining the connection.
      http2Session.emit("goaway", constants.NGHTTP2_NO_ERROR, 0);

      expect(session.state).toBe("draining");
      expect(() => session.request({ ":method": "GET", ":path": "/" })).toThrow("not accepting new streams");

      existing.close(constants.NGHTTP2_NO_ERROR);
    });
  });

  describe("GOAWAY handling", () => {
    it("closes the session immediately when there are no active streams", async () => {
      const session = new TunnelHost.Session(http2Session);

      http2Session.emit("goaway", constants.NGHTTP2_NO_ERROR, 0);

      // No active streams: the wrapper closes the session right away.
      expect(session.closed).toBe(true);
      expect(session.state).toBe("closed");
    });

    it("waits for active streams to finish before closing", async () => {
      const session = new TunnelHost.Session(http2Session);
      const stream = session.request({ ":method": "GET", ":path": "/" });

      http2Session.emit("goaway", constants.NGHTTP2_NO_ERROR, 0);

      // Still draining because the stream is open.
      expect(session.state).toBe("draining");
      expect(session.closed).toBe(false);

      stream.close(constants.NGHTTP2_NO_ERROR);

      await new Promise<void>((resolve) => stream.once("close", resolve));

      expect(session.closed).toBe(true);
    });
  });

  describe("liveness probing", () => {
    it("probes on idle timeout and stays open on a successful acknowledgement", async () => {
      const ping = vi.spyOn(http2Session, "ping").mockImplementation((_payload, cb) => {
        cb(null, 0, Buffer.alloc(0));
        return true;
      });

      const session = new TunnelHost.Session(http2Session);

      // Trigger the idle timeout (as the raw session would after `idleTimeoutMs`).
      http2Session.emit("timeout");

      expect(ping).toHaveBeenCalledTimes(1);
      expect(session.state).toBe("open");
      expect(session.destroyed).toBe(false);
    });

    it("re-arms the idle timer and probes again after a successful probe", async () => {
      const ping = vi.spyOn(http2Session, "ping").mockImplementation((_payload, cb) => {
        cb(null, 0, Buffer.alloc(0));
        return true;
      });

      const rearm = vi.spyOn(http2Session, "setTimeout").mockImplementation(() => http2Session);
      const _ = new TunnelHost.Session(http2Session);

      rearm.mockClear(); // ignore the arm performed by the constructor

      http2Session.emit("timeout");
      await vi.waitFor(() => expect(rearm).toHaveBeenCalledTimes(1)); // successful probe re-arms

      http2Session.emit("timeout");
      expect(ping).toHaveBeenCalledTimes(2);
    });

    it("does not destroy the session on a single failed probe", async () => {
      vi.spyOn(http2Session, "ping").mockImplementation((_payload, cb) => {
        cb(new Error("PING failed"), 0, Buffer.alloc(0));
        return true;
      });
      const session = new TunnelHost.Session(http2Session);

      http2Session.emit("timeout");

      expect(session.state).toBe("open");
      expect(session.destroyed).toBe(false);
    });

    it("destroys the session only after the consecutive-failure threshold is reached", async () => {
      vi.spyOn(http2Session, "ping").mockImplementation((_payload, cb) => {
        cb(new Error("PING failed"), 0, Buffer.alloc(0));
        return true;
      });
      const rearm = vi.spyOn(http2Session, "setTimeout").mockImplementation(() => http2Session);
      const session = new TunnelHost.Session(http2Session);

      rearm.mockClear();

      // Three consecutive idle probes, all failing.
      http2Session.emit("timeout");
      await vi.waitFor(() => expect(rearm).toHaveBeenCalledTimes(1));

      http2Session.emit("timeout");
      await vi.waitFor(() => expect(rearm).toHaveBeenCalledTimes(2));

      http2Session.emit("timeout");
      await vi.waitFor(() => expect(session.destroyed).toBe(true));

      expect(session.state).toBe("error");
    });

    it("resets the failure streak after a successful probe", async () => {
      vi.spyOn(http2Session, "ping")
        // Two failures
        .mockImplementationOnce((_payload, cb) => {
          cb(new Error("fail 1"), 0, Buffer.alloc(0));
          return true;
        })
        .mockImplementationOnce((_payload, cb) => {
          cb(new Error("fail 2"), 0, Buffer.alloc(0));
          return true;
        })
        // then a success
        .mockImplementationOnce((_payload, cb) => {
          cb(null, 0, Buffer.alloc(0));
          return true;
        })
        // then two more failures: should NOT destroy.
        .mockImplementation((_payload, cb) => {
          cb(new Error("fail later"), 0, Buffer.alloc(0));
          return true;
        });

      const rearm = vi.spyOn(http2Session, "setTimeout").mockImplementation(() => http2Session);
      const session = new TunnelHost.Session(http2Session);

      rearm.mockClear();

      http2Session.emit("timeout"); // fail 1
      await vi.waitFor(() => expect(rearm).toHaveBeenCalledTimes(1));
      http2Session.emit("timeout"); // fail 2
      await vi.waitFor(() => expect(rearm).toHaveBeenCalledTimes(2));
      http2Session.emit("timeout"); // success
      await vi.waitFor(() => expect(rearm).toHaveBeenCalledTimes(3));
      http2Session.emit("timeout"); // fail later
      await vi.waitFor(() => expect(rearm).toHaveBeenCalledTimes(4));
      http2Session.emit("timeout"); // fail later
      await vi.waitFor(() => expect(rearm).toHaveBeenCalledTimes(5));

      expect(session.state).toBe("open");
      expect(session.destroyed).toBe(false);
    });

    it("treats an unacknowledged PING as a failed probe via the probe timeout", async () => {
      // A peer that never acknowledges PINGs: the wrapper's own probe timeout
      // must fire and count as a failure instead of hanging forever.
      const ping = vi.spyOn(http2Session, "ping").mockImplementation(() => true);
      const rearm = vi.spyOn(http2Session, "setTimeout").mockImplementation(() => http2Session);
      const session = new TunnelHost.Session(http2Session, {
        idleTimeoutMs: 60_000,
        probeTimeoutMs: 30,
        probeFailureThreshold: 2,
      });
      rearm.mockClear();

      http2Session.emit("timeout");
      expect(ping).toHaveBeenCalledTimes(1);

      // First probe times out (unacknowledged), still under threshold → re-arms.
      await vi.waitFor(() => expect(rearm).toHaveBeenCalledTimes(1));

      // Second idle probe also times out → threshold reached.
      http2Session.emit("timeout");
      await vi.waitFor(() => expect(session.destroyed).toBe(true));
    });

    it("ignores overlapping probes while one is in flight", async () => {
      const ping = vi.spyOn(http2Session, "ping").mockImplementation((_payload, cb) => {
        cb(null, 0, Buffer.alloc(0));
        return true;
      });

      new TunnelHost.Session(http2Session);

      http2Session.emit("timeout");
      http2Session.emit("timeout");
      http2Session.emit("timeout");

      // Only the first idle timeout should start a probe.
      expect(ping).toHaveBeenCalledTimes(1);
    });
  });
});

describe("TunnelHost", () => {
  let http2Server: ReturnType<typeof createServer>;
  let pairs: SocketPair;
  let host: TunnelHost;
  let serverStreams: Set<ServerHttp2Stream>;
  let serverStreamHeaders: Map<ServerHttp2Stream, Record<string, string | string[] | undefined>>;

  beforeEach(async () => {
    serverStreams = new Set();
    serverStreamHeaders = new Map();

    // The guest side: a cleartext HTTP/2 server that accepts the extended
    // CONNECT streams the tunnel carries per TCP connection.
    http2Server = createServer();

    http2Server.on("stream", (stream, headers) => {
      const http2Stream = stream as ServerHttp2Stream;
      serverStreams.add(http2Stream);
      serverStreamHeaders.set(http2Stream, headers);

      // Accept the extended CONNECT stream so the host's `#prepareStream`
      // finishes bridging the socket pair.
      http2Stream.respond({ ":status": 200 });
    });

    // Advertise extended CONNECT (RFC 8441) so `:protocol` is accepted.
    http2Server.on("session", (session) => {
      session.settings({ enableConnectProtocol: true });
    });

    http2Server.on("sessionError", () => {});

    // Wire the guest's HTTP/2 server and the host together through a single
    // socket pair: the pair's server side becomes the HTTP/2 server's h2c
    // transport, and the host upgrades the pair's client side into a session.
    pairs = new SocketPair({});
    const pair = await pairs.create();

    http2Server.emit("connection", pair.server);

    host = new TunnelHost({});

    await host.upgrade(pair.client);
  });

  afterEach(async () => {
    // Tear down any open streams first so the host's session close below has
    // no active streams to wait on.
    for (const stream of serverStreams) {
      if (!stream.destroyed) {
        stream.destroy();
      }
    }

    await host.close();
    await pairs.close();
    await new Promise<void>((resolve) => http2Server.close(() => resolve()));
  });

  it("upgrades the socket-pair side into a session that carries extended CONNECT streams", async () => {
    const client = await host.connect({ authority: "example.com:8080" });

    // The guest must have received exactly one extended CONNECT stream.
    expect(serverStreams.size).toBe(1);

    const stream = [...serverStreams][0];
    const headers = serverStreamHeaders.get(stream);
    expect(headers?.[":method"]).toBe("CONNECT");
    expect(headers?.[":protocol"]).toBe("tcp");
    expect(headers?.[":authority"]).toBe("example.com:8080");

    // `#prepareStream` only resolves after the guest's response headers arrive,
    // so by the time `connect()` returns the stream has already sent them.
    expect(stream.headersSent).toBeTruthy();

    client.destroy();
  });

  it("bridges bytes bidirectionally between the local socket and the Http2Stream", async () => {
    const client = await host.connect({ authority: "example.com:8080" });
    const stream = [...serverStreams][0];

    const fromClient: Buffer[] = [];
    const clientData = new Promise<void>((resolve) => {
      stream.on("data", (chunk) => {
        fromClient.push(Buffer.from(chunk));
        resolve();
      });
    });

    const fromGuest: Buffer[] = [];
    const guestData = new Promise<void>((resolve) => {
      client.on("data", (chunk) => {
        fromGuest.push(Buffer.from(chunk));
        resolve();
      });
    });

    client.write("ping-from-host");
    await clientData;
    expect(Buffer.concat(fromClient).toString()).toContain("ping-from-host");

    stream.write("pong-from-guest");
    await guestData;
    expect(Buffer.concat(fromGuest).toString()).toContain("pong-from-guest");

    client.destroy();
  });

  it("closes the local socket when the Http2Stream is closed by the guest", async () => {
    const client = await host.connect({ authority: "example.com:8080" });
    const stream = [...serverStreams][0];

    const closed = new Promise<void>((resolve) => client.once("close", resolve));

    // The guest tears down the stream; the paired socket must follow suit.
    stream.close(constants.NGHTTP2_NO_ERROR);

    await closed;

    expect(client.destroyed).toBe(true);
  });

  it("ends the Http2Stream when the local socket is ended", async () => {
    const client = await host.connect({ authority: "example.com:8080" });
    const stream = [...serverStreams][0];

    const streamEnded = new Promise<void>((resolve) => stream.once("end", resolve));

    // Ending the local socket signals an end of write on the bridged pair,
    // which propagates an END_STREAM to the guest.
    client.end();

    await streamEnded;

    expect(stream.readableEnded).toBe(true);
    expect(stream.writableEnded).toBe(false);
  });
});
