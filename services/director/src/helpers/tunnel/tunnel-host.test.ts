import { type ClientHttp2Session, connect, constants, createServer, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SocketPair } from "./socket-pair";
import { TunnelHost } from "./tunnel-host";

/**
 * Tests for `TunnelHost.Session`, the wrapper around a `ClientHttp2Session`.
 *
 * The wrapper is constructed over a real `node:http2` client session so that
 * stream/state lifecycle assertions reflect actual socket behavior. For the
 * liveness-probe logic, the underlying session's `ping` method is stubbed so
 * the probe engine can be exercised deterministically (acknowledgement,
 * timeout, and the consecutive-failure threshold) without depending on the
 * timing of real PING frames.
 */

describe("TunnelHost.Session", () => {
  let server: ReturnType<typeof createServer>;
  let raw: ClientHttp2Session;
  let serverStreams: Set<ServerHttp2Stream>;

  /** Resolves once the raw session handshake is complete. */
  const waitForConnect = (s: ClientHttp2Session) =>
    new Promise<void>((resolve, reject) => {
      s.once("connect", () => resolve());
      s.once("error", reject);
    });

  const waitFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** Replaces raw.ping with a controllable stub. */
  type PingStub = {
    calls: number;
    ack: () => void;
    fail: (error: Error) => void;
  };

  function stubPing(options: { neverAck?: boolean; rejectWith?: Error } = {}): PingStub {
    const stub: PingStub = {
      calls: 0,
      ack: () => {},
      fail: () => {},
    };

    const pending: Array<(error: Error | null) => void> = [];

    stub.ack = () => {
      for (const cb of pending.splice(0)) {
        cb(null);
      }
    };

    stub.fail = (error) => {
      for (const cb of pending.splice(0)) {
        cb(error);
      }
    };

    raw.ping = ((_payload: Buffer, callback: (error: Error | null) => void) => {
      stub.calls += 1;

      if (options.neverAck) {
        // Simulate a dead/ungreachable peer: the callback is never invoked,
        // relying on the wrapper's own probe timeout.
        return true;
      }

      pending.push(callback);
      return true;
    }) as ClientHttp2Session["ping"];

    return stub;
  }

  beforeEach(async () => {
    serverStreams = new Set();

    server = createServer();

    server.on("stream", (stream) => {
      serverStreams.add(stream as ServerHttp2Stream);
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));

    const port = (server.address() as AddressInfo).port;

    raw = connect(`http://localhost:${port}`);
    await waitForConnect(raw);
  });

  afterEach(async () => {
    for (const stream of serverStreams) {
      stream.close(constants.NGHTTP2_NO_ERROR);
    }

    raw.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("state and lifecycle", () => {
    it("starts in the open state with no active streams", () => {
      const session = new TunnelHost.Session(raw);

      expect(session.state).toBe("open");
      expect(session.activeStreamCount).toBe(0);
      expect(session.closed).toBe(false);
      expect(session.destroyed).toBe(false);
    });

    it("transitions to error state when the raw session emits an error", () => {
      const session = new TunnelHost.Session(raw);

      raw.emit("error", new Error("boom"));

      expect(session.state).toBe("error");
    });

    it("destroy() is idempotent and marks the session destroyed", () => {
      const session = new TunnelHost.Session(raw);

      session.destroy(new Error("shutdown"));
      session.destroy(new Error("again"));

      expect(session.destroyed).toBe(true);
      expect(session.state).toBe("error");
    });

    it("close() resolves once the raw session is closed", async () => {
      const session = new TunnelHost.Session(raw);

      await session.close();

      expect(session.closed).toBe(true);
      expect(session.state).toBe("closed");
    });
  });

  describe("request()", () => {
    it("returns a stream and tracks it as an active stream", () => {
      const session = new TunnelHost.Session(raw);
      const stream = session.request({ ":method": "GET", ":path": "/" });

      expect(stream).toBeDefined();
      expect(session.activeStreamCount).toBe(1);
    });

    it("decrements the active stream count when the stream closes", async () => {
      const session = new TunnelHost.Session(raw);
      const stream = session.request({ ":method": "GET", ":path": "/" });

      expect(session.activeStreamCount).toBe(1);

      stream.close(constants.NGHTTP2_NO_ERROR);

      await new Promise<void>((resolve) => stream.once("close", resolve));

      expect(session.activeStreamCount).toBe(0);
    });

    it("rejects new streams once a GOAWAY has been received", async () => {
      const session = new TunnelHost.Session(raw);

      // Keep one stream open so the session lingers in the draining state.
      const existing = session.request({ ":method": "GET", ":path": "/" });

      // Simulate the peer gracefully draining the connection.
      raw.emit("goaway", constants.NGHTTP2_NO_ERROR, 0);

      expect(session.state).toBe("draining");
      expect(() => session.request({ ":method": "GET", ":path": "/" })).toThrow("not accepting new streams");

      existing.close(constants.NGHTTP2_NO_ERROR);
    });
  });

  describe("GOAWAY handling", () => {
    it("closes the session immediately when there are no active streams", async () => {
      const session = new TunnelHost.Session(raw);

      raw.emit("goaway", constants.NGHTTP2_NO_ERROR, 0);

      // No active streams: the wrapper closes the session right away.
      expect(session.closed).toBe(true);
      expect(session.state).toBe("closed");
    });

    it("waits for active streams to finish before closing", async () => {
      const session = new TunnelHost.Session(raw);
      const stream = session.request({ ":method": "GET", ":path": "/" });

      raw.emit("goaway", constants.NGHTTP2_NO_ERROR, 0);

      // Still draining because the stream is open.
      expect(session.state).toBe("draining");
      expect(session.closed).toBe(false);

      stream.close(constants.NGHTTP2_NO_ERROR);
      await new Promise<void>((resolve) => stream.once("close", resolve));
      await waitFor(10);

      expect(session.closed).toBe(true);
    });
  });

  describe("liveness probing", () => {
    it("probes on idle timeout and stays open on a successful acknowledgement", async () => {
      const ping = stubPing();
      const session = new TunnelHost.Session(raw, { idleTimeoutMs: 10, probeTimeoutMs: 100 });

      // Trigger the idle timeout (as the raw session would after `idleTimeoutMs`).
      raw.emit("timeout");

      expect(ping.calls).toBe(1);

      // The peer acknowledges the PING.
      ping.ack();
      await waitFor(10);

      expect(session.state).toBe("open");
      expect(session.destroyed).toBe(false);
    });

    it("re-arms the idle timer and probes again after a successful probe", async () => {
      const ping = stubPing();
      const session = new TunnelHost.Session(raw, { idleTimeoutMs: 10, probeTimeoutMs: 100 });

      raw.emit("timeout");
      ping.ack();
      await waitFor(10);

      raw.emit("timeout");
      expect(ping.calls).toBe(2);

      ping.ack();
      await waitFor(10);
      expect(session.state).toBe("open");
    });

    it("does not destroy the session on a single failed probe", async () => {
      const ping = stubPing();
      const session = new TunnelHost.Session(raw, { idleTimeoutMs: 10, probeTimeoutMs: 100, probeFailureThreshold: 3 });

      raw.emit("timeout");
      ping.fail(new Error("PING failed"));

      await waitFor(10);

      expect(session.state).toBe("open");
      expect(session.destroyed).toBe(false);
    });

    it("destroys the session only after the consecutive-failure threshold is reached", async () => {
      const ping = stubPing();
      const session = new TunnelHost.Session(raw, { idleTimeoutMs: 10, probeTimeoutMs: 100, probeFailureThreshold: 3 });

      // Three consecutive idle probes, all failing.
      raw.emit("timeout");
      ping.fail(new Error("PING failed"));

      await waitFor(10);
      raw.emit("timeout");
      ping.fail(new Error("PING failed"));

      await waitFor(10);
      raw.emit("timeout");
      ping.fail(new Error("PING failed"));

      await waitFor(10);

      expect(session.destroyed).toBe(true);
      expect(session.state).toBe("error");
    });

    it("resets the failure streak after a successful probe", async () => {
      const ping = stubPing();
      const session = new TunnelHost.Session(raw, { idleTimeoutMs: 10, probeTimeoutMs: 100, probeFailureThreshold: 3 });

      // Two failures, then a success, then two more failures: should NOT destroy.
      raw.emit("timeout");
      ping.fail(new Error("fail 1"));
      await waitFor(10);

      raw.emit("timeout");
      ping.fail(new Error("fail 2"));
      await waitFor(10);

      raw.emit("timeout");
      ping.ack();
      await waitFor(10);

      raw.emit("timeout");
      ping.fail(new Error("fail 3"));
      await waitFor(10);

      raw.emit("timeout");
      ping.fail(new Error("fail 4"));
      await waitFor(10);

      expect(session.state).toBe("open");
      expect(session.destroyed).toBe(false);
    });

    it("treats an unacknowledged PING as a failed probe via the probe timeout", async () => {
      // A peer that never acknowledges PINGs: the wrapper's own probe timeout
      // must fire and count as a failure instead of hanging forever.
      const ping = stubPing({ neverAck: true });
      const session = new TunnelHost.Session(raw, {
        idleTimeoutMs: 10,
        probeTimeoutMs: 30,
        probeFailureThreshold: 2,
      });

      raw.emit("timeout");
      expect(ping.calls).toBe(1);

      // First probe times out (unacknowledged).
      await waitFor(50);
      expect(session.state).toBe("open");
      expect(session.destroyed).toBe(false);

      // Second idle probe also times out → threshold reached.
      raw.emit("timeout");
      await waitFor(50);

      expect(session.destroyed).toBe(true);
    });

    it("ignores overlapping probes while one is in flight", async () => {
      const ping = stubPing();
      new TunnelHost.Session(raw, { idleTimeoutMs: 10, probeTimeoutMs: 100 });

      raw.emit("timeout");
      raw.emit("timeout");
      raw.emit("timeout");

      // Only the first idle timeout should start a probe.
      expect(ping.calls).toBe(1);

      ping.ack();
      await waitFor(10);
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
    pairs = new SocketPair({ socketPath: join(tmpdir(), `tunnel-host-test-${process.pid}.sock`) });
    const pair = await pairs.create();

    http2Server.emit("connection", pair.server);

    host = new TunnelHost({ socketPath: join(tmpdir(), `tunnel-host-pairs-${process.pid}.sock`) });

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
