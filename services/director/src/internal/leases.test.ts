import { Logger } from "@aw/logging";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Leases } from "@/internal/leases";

describe("Leases", () => {
  let logger: Logger;
  let leases: Leases;

  beforeEach(() => {
    logger = new Logger();
    leases = new Leases(logger);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getOrCreateLease", () => {
    it("creates a new lease when none exists", () => {
      const lease = leases.getOrCreateLease("supervisor-1", "process-1");

      expect(lease.supervisor).toBe("supervisor-1");
      expect(lease.processId).toBe("process-1");
      expect(lease.online).toBe(true);
      expect(leases.getLease("supervisor-1")).toBe(lease);
      expect(leases.getAllLeases()).toHaveLength(1);
    });

    it("throws a LeaseConflict when the same processId calls while already online", () => {
      leases.getOrCreateLease("supervisor-1", "process-1");

      expect(() => leases.getOrCreateLease("supervisor-1", "process-1")).toThrow(Leases.Exception);
      expect(leases.getAllLeases()).toHaveLength(1);
    });

    it("revives an expiring lease when the same processId reconnects", () => {
      const lease = leases.getOrCreateLease("supervisor-1", "process-1");

      lease.expire();
      expect(lease.expiring).toBe(true);

      const revived = leases.getOrCreateLease("supervisor-1", "process-1");

      expect(revived).toBe(lease);
      expect(revived.online).toBe(true);
      expect(revived.expiring).toBe(false);
    });

    it("throws a LeaseConflict when a different processId attempts to take an online lease", () => {
      leases.getOrCreateLease("supervisor-1", "process-1");

      expect(() => leases.getOrCreateLease("supervisor-1", "process-2")).toThrow(Leases.Exception);
    });

    it("reports the LeaseConflict code when a different processId contests an online lease", () => {
      leases.getOrCreateLease("supervisor-1", "process-1");

      try {
        leases.getOrCreateLease("supervisor-1", "process-2");
        throw new Error("expected getOrCreateLease to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Leases.Exception);
        expect((error as Leases.Exception).code).toBe(Leases.Exception.Code.LeaseConflict);
      }
    });

    it("replaces an expiring lease with a different processId", () => {
      const oldLease = leases.getOrCreateLease("supervisor-1", "process-1");

      oldLease.expire();
      expect(oldLease.expiring).toBe(true);

      const newLease = leases.getOrCreateLease("supervisor-1", "process-2");

      expect(newLease).not.toBe(oldLease);
      expect(newLease.processId).toBe("process-2");
      expect(newLease.online).toBe(true);
      expect(oldLease.destroyed).toBe(true);
      expect(leases.getLease("supervisor-1")).toBe(newLease);
      expect(leases.getAllLeases()).toHaveLength(1);
    });

    it("removes a lease from the map when it is destroyed", () => {
      const lease = leases.getOrCreateLease("supervisor-1", "process-1");

      lease.destroy();

      expect(leases.getLease("supervisor-1")).toBeUndefined();
      expect(leases.getAllLeases()).toHaveLength(0);
    });

    it("keeps the most recent lease in the map when an older lease is destroyed", () => {
      const oldLease = leases.getOrCreateLease("supervisor-1", "process-1");
      oldLease.expire();
      const newLease = leases.getOrCreateLease("supervisor-1", "process-2");

      // Destroying the already-replaced old lease must not evict the current one.
      oldLease.destroy();

      expect(leases.getLease("supervisor-1")).toBe(newLease);
      expect(leases.getAllLeases()).toHaveLength(1);
    });
  });

  describe("Lease", () => {
    it("starts online", () => {
      const lease = leases.getOrCreateLease("supervisor-1", "process-1");

      expect(lease.state).toBe(Leases.Lease.State.Online);
      expect(lease.online).toBe(true);
      expect(lease.expiring).toBe(false);
      expect(lease.destroyed).toBe(false);
    });

    it("expires into the Expiring state", () => {
      const lease = leases.getOrCreateLease("supervisor-1", "process-1");

      lease.expire();

      expect(lease.state).toBe(Leases.Lease.State.Expiring);
      expect(lease.online).toBe(false);
      expect(lease.expiring).toBe(true);
    });

    it("revives an expiring lease back to online", () => {
      const lease = leases.getOrCreateLease("supervisor-1", "process-1");

      lease.expire();
      lease.revive();

      expect(lease.state).toBe(Leases.Lease.State.Online);
      expect(lease.online).toBe(true);
    });

    it("does not revive a destroyed lease", () => {
      const lease = leases.getOrCreateLease("supervisor-1", "process-1");

      lease.destroy();
      lease.revive();

      expect(lease.destroyed).toBe(true);
      expect(lease.online).toBe(false);
    });

    it("destroys a lease into the Destroyed state", () => {
      const lease = leases.getOrCreateLease("supervisor-1", "process-1");

      lease.destroy();

      expect(lease.state).toBe(Leases.Lease.State.Destroyed);
      expect(lease.destroyed).toBe(true);
    });

    it("auto-destroys after the expire countdown", () => {
      vi.useFakeTimers();

      const lease = leases.getOrCreateLease("supervisor-1", "process-1");

      lease.expire();
      expect(lease.expiring).toBe(true);

      vi.advanceTimersByTime(Leases.LEASE_EXPIRE_COUNTDOWN_MS);

      expect(lease.destroyed).toBe(true);
    });

    it("does not schedule destruction when already expiring or destroyed", () => {
      const lease = leases.getOrCreateLease("supervisor-1", "process-1");

      lease.destroy();
      lease.expire();

      expect(lease.destroyed).toBe(true);
    });

    describe("socket pool", () => {
      it("adds a socket to the idle pool", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");
        const socket = new PassThrough();

        lease.sockets.add(socket);

        expect(lease.sockets.total).toBe(1);
        expect(lease.sockets.idle).toBe(1);
        expect(lease.sockets.active).toBe(0);

        socket.destroy();
      });

      it("rejects a socket when the pool is at capacity", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1", { maxSockets: 1 });
        const first = new PassThrough();
        const second = new PassThrough();

        lease.sockets.add(first);
        lease.sockets.add(second);

        expect(second.destroyed).toBe(true);

        first.destroy();
      });

      it("removes a socket from the pool when it closes", async () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");
        const socket = new PassThrough();

        lease.sockets.add(socket);
        expect(lease.sockets.total).toBe(1);

        const closed = once(socket, "close");

        socket.destroy();

        await closed;

        expect(lease.sockets.total).toBe(0);
        expect(lease.sockets.idle).toBe(0);
      });

      it("claims a socket and marks it in-use", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");
        const socket = new PassThrough();

        lease.sockets.add(socket);

        const claimed = lease.sockets.claim();

        expect(claimed).toBe(socket);
        expect(lease.sockets.idle).toBe(0);
        expect(lease.sockets.active).toBe(1);
        expect(lease.sockets.total).toBe(1);

        socket.destroy();
      });

      it("returns null when claiming from an empty pool", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");

        expect(lease.sockets.claim()).toBeNull();
      });

      it("skips dead sockets when claiming", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");
        const dead = new PassThrough();
        const alive = new PassThrough();

        lease.sockets.add(dead);
        lease.sockets.add(alive);
        dead.destroy();

        const claimed = lease.sockets.claim();

        expect(claimed).toBe(alive);
        expect(lease.sockets.active).toBe(1);

        alive.destroy();
      });

      it("returns a socket to the pool and clears its in-use marker", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");
        const socket = new PassThrough();

        lease.sockets.add(socket);
        const claimed = lease.sockets.claim();

        expect(claimed).toBe(socket);
        expect(lease.sockets.active).toBe(1);

        lease.sockets.release(socket);

        expect(lease.sockets.idle).toBe(1);
        expect(lease.sockets.active).toBe(0);
        expect(lease.sockets.total).toBe(1);

        socket.destroy();
      });

      it("destroys a dead socket instead of returning it to the pool", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");
        const socket = new PassThrough();

        lease.sockets.add(socket);
        lease.sockets.claim();
        socket.destroy();

        lease.sockets.release(socket);

        expect(lease.sockets.idle).toBe(0);
        expect(lease.sockets.active).toBe(0);
        expect(lease.sockets.total).toBe(0);
      });

      it("destroys all managed sockets when the lease is destroyed", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");
        const idle = new PassThrough();
        const active = new PassThrough();

        lease.sockets.add(idle);
        lease.sockets.add(active);
        lease.sockets.claim(); // claims `idle`, marks it in-use

        expect(lease.sockets.total).toBe(2);

        lease.destroy();

        expect(idle.destroyed).toBe(true);
        expect(active.destroyed).toBe(true);
        expect(lease.sockets.total).toBe(0);
        expect(lease.sockets.idle).toBe(0);
        expect(lease.sockets.active).toBe(0);
      });

      it("auto-creates a socket pool and manages its lifecycle", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");

        expect(lease.sockets).toBeInstanceOf(Leases.SocketPool);
        expect(lease.sockets.destroyed).toBe(false);

        lease.destroy();

        expect(lease.sockets.destroyed).toBe(true);
      });
    });

    describe("subscriptions", () => {
      it("notifies subscribers of assignment-list changes", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");
        const listener = vi.fn();
        lease.subscribe(listener);

        lease.notifyAssignmentListChanged();

        expect(listener).toHaveBeenCalledWith({ type: "assignment-list-changed" });
      });

      it("notifies subscribers of assignment revocation", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");
        const listener = vi.fn();
        lease.subscribe(listener);

        lease.notifyAssignmentRevoked("assignment-1");

        expect(listener).toHaveBeenCalledWith({ type: "assignment-revoked", id: "assignment-1" });
      });

      it("notifies subscribers when destroyed", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");
        const listener = vi.fn();
        lease.subscribe(listener);

        lease.destroy();

        expect(listener).toHaveBeenCalledWith({ type: "destroyed" });
      });

      it("returns an unsubscribe function that detaches the listener", () => {
        const lease = leases.getOrCreateLease("supervisor-1", "process-1");
        const listener = vi.fn();
        const unsubscribe = lease.subscribe(listener);

        unsubscribe();
        lease.notifyAssignmentListChanged();

        expect(listener).not.toHaveBeenCalled();
      });
    });
  });

  describe("SocketPool", () => {
    function makePool(options?: { max?: number }) {
      return new Leases.SocketPool({
        logger: new Logger(),
        ...options,
      });
    }

    it("adds a socket to the idle pool", () => {
      const pool = makePool();
      const socket = new PassThrough();

      pool.add(socket);

      expect(pool.total).toBe(1);
      expect(pool.idle).toBe(1);
      expect(pool.active).toBe(0);

      socket.destroy();
    });

    it("rejects a socket when at capacity", () => {
      const pool = makePool({ max: 1 });
      const first = new PassThrough();
      const second = new PassThrough();

      pool.add(first);
      pool.add(second);

      expect(second.destroyed).toBe(true);

      first.destroy();
    });

    it("claims a socket and marks it in-use", () => {
      const pool = makePool();
      const socket = new PassThrough();

      pool.add(socket);

      const claimed = pool.claim();

      expect(claimed).toBe(socket);
      expect(pool.idle).toBe(0);
      expect(pool.active).toBe(1);
      expect(pool.total).toBe(1);

      socket.destroy();
    });

    it("returns a socket to the pool and clears its in-use marker", () => {
      const pool = makePool();
      const socket = new PassThrough();

      pool.add(socket);
      pool.claim();
      pool.release(socket);

      expect(pool.idle).toBe(1);
      expect(pool.active).toBe(0);
      expect(pool.total).toBe(1);

      socket.destroy();
    });

    it("destroys all sockets and marks itself destroyed", async () => {
      const pool = makePool();
      const idle = new PassThrough();
      const active = new PassThrough();

      pool.add(idle);
      pool.add(active);
      pool.claim(); // claims `idle`, marks it in-use

      const closed = Promise.all([once(idle, "close"), once(active, "close")]);

      pool.destroy();

      await closed;

      expect(idle.destroyed).toBe(true);
      expect(active.destroyed).toBe(true);
      expect(pool.destroyed).toBe(true);
      expect(pool.total).toBe(0);
      expect(pool.idle).toBe(0);
      expect(pool.active).toBe(0);
    });

    it("rejects new sockets after being destroyed", () => {
      const pool = makePool();
      const socket = new PassThrough();

      pool.destroy();
      pool.add(socket);

      expect(socket.destroyed).toBe(true);
    });
  });

  describe("Exception", () => {
    it("exposes the code", () => {
      const exception = new Leases.Exception(Leases.Exception.Code.LeaseConflict, "conflict");

      expect(exception).toBeInstanceOf(Error);
      expect(exception.code).toBe(Leases.Exception.Code.LeaseConflict);
      expect(exception.message).toBe("conflict");
    });
  });
});
