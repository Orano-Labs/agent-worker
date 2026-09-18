import type { Duplex } from "node:stream";
import { Container } from "@aw/container";
import type { Logger } from "@aw/logging";

export class Leases extends Container.ServiceConstructable {
  #leases: Map<string, Leases.Lease>;

  #logger: Logger;

  constructor(...deps: [Logger]) {
    super();

    this.#leases = new Map();

    this.#logger = deps[0].namespace("Supervisors");
  }

  getLease(supervisor: string) {
    return this.#leases.get(supervisor);
  }

  getOrCreateLease(supervisor: string, processId: string, options?: { maxSockets?: number }) {
    let lease = this.#leases.get(supervisor);

    if (lease) {
      if (lease.processId === processId && lease.expiring) {
        // Same processId reconnecting: reuse the existing Lease and cancel its expire countdown.
        lease.revive();

        return lease;
      }

      // Different processId: only replace the old Lease once it has entered the expire countdown
      // (no longer online), ensuring only one online processId at any given time.
      if (lease.online) {
        // biome-ignore format:x
        throw new Leases.Exception(Leases.Exception.Code.LeaseConflict, `Supervisor already has an online process "${lease.processId}".`);
      }

      this.#logger.warn("Replacing expiring lease with a new process", {
        supervisor,
        oldProcessId: lease.processId,
        newProcessId: processId,
      });

      lease.destroy();
    }

    lease = new Leases.Lease({
      logger: this.#logger,
      id: supervisor,
      processId,
      maxSockets: options?.maxSockets,
    });

    lease.subscribe(({ type }) => {
      if (type === "destroyed") {
        if (lease === this.#leases.get(supervisor)) {
          this.#leases.delete(supervisor);
        }
      }
    });

    this.#leases.set(supervisor, lease);

    return lease;
  }

  getAllLeases() {
    return [...this.#leases.values()];
  }
}

export namespace Leases {
  export const LEASE_EXPIRE_COUNTDOWN_MS = 3_000;

  export class SocketPool {
    #logger: Logger;
    #max: number;
    #idleSockets: Duplex[];
    #inUseSockets: Set<Duplex>;
    #destroyed: boolean;

    constructor(options: SocketPool.Options) {
      this.#logger = options.logger.namespace("SocketPool");
      this.#max = options.max ?? SocketPool.DEFAULT_MAX_SOCKETS;
      this.#idleSockets = [];
      this.#inUseSockets = new Set();
      this.#destroyed = false;
    }

    get total() {
      return this.#idleSockets.length + this.#inUseSockets.size;
    }

    get idle() {
      return this.#idleSockets.length;
    }

    get active() {
      return this.#inUseSockets.size;
    }

    get max() {
      return this.#max;
    }

    get destroyed() {
      return this.#destroyed;
    }

    add(socket: Duplex) {
      if (this.#destroyed) {
        try {
          socket.write(
            `HTTP/1.1 503 Service Unavailable\r\n` +
              `Content-Type: text/plain\r\n` +
              `Content-Length: ${Buffer.byteLength("Socket pool is destroyed")}\r\n` +
              `Connection: close\r\n` +
              `\r\n` +
              "Socket pool is destroyed",
          );
        } catch {
          //
        }

        socket.destroy();

        return;
      }

      if (this.total >= this.#max) {
        this.#logger.debug("Socket pool is full, rejecting new socket", {
          total: this.total,
        });

        try {
          socket.write(
            `HTTP/1.1 503 Service Unavailable\r\n` +
              `Content-Type: text/plain\r\n` +
              `Content-Length: ${Buffer.byteLength("Tunnel connection pool is full")}\r\n` +
              `Connection: close\r\n` +
              `\r\n` +
              "Tunnel connection pool is full",
          );
        } catch {
          //
        }

        socket.destroy();

        return;
      }

      const close = () => {
        this.#inUseSockets.delete(socket);

        const idx = this.#idleSockets.indexOf(socket);

        if (idx >= 0) {
          this.#idleSockets.splice(idx, 1);
        }

        this.#logger.debug("Socket closed", {
          total: this.total,
        });
      };

      socket.once("close", close);
      socket.once("error", (err) => {
        this.#logger.debug("Socket error, destroying", {
          err,
        });

        socket.destroy();
      });

      socket.write("HTTP/1.1 101 Switching Protocols\r\n" + "Upgrade: tunnel\r\n" + "Connection: Upgrade\r\n" + "\r\n");

      this.#idleSockets.push(socket);

      this.#logger.debug("Socket attached to pool", {
        total: this.total,
      });
    }

    claim() {
      while (true) {
        const socket = this.#idleSockets.shift();

        if (!socket) {
          return null;
        }

        // After pruning all should be alive, but check defensively.
        if (!socket.destroyed && socket.writable && socket.readable) {
          this.#inUseSockets.add(socket);

          return socket;
        }

        this.#logger.debug("Claimed socket was dead on arrival, skipping");

        socket.destroy();
      }
    }

    release(socket: Duplex) {
      if (!this.#inUseSockets.delete(socket)) {
        return;
      }

      if (!socket.destroyed && socket.writable && socket.readable) {
        this.#idleSockets.push(socket);
      } else {
        socket.destroy();
      }
    }

    destroy() {
      if (this.#destroyed) {
        return;
      }

      this.#destroyed = true;

      const sockets = [...this.#idleSockets, ...this.#inUseSockets];

      this.#idleSockets = [];
      this.#inUseSockets.clear();

      for (const socket of sockets) {
        if (!socket.destroyed) {
          socket.destroy();
        }
      }
    }
  }

  export namespace SocketPool {
    export const DEFAULT_MAX_SOCKETS = 3_000; // TODO: derive from configuration/environment.

    export type Options = {
      logger: Logger;
      max?: number;
    };
  }

  export class Lease {
    #logger: Logger;
    #timer: ReturnType<typeof setTimeout> | null;
    #processId: string;
    #supervisor: string;
    #state: Lease.State;
    #subscribers: Set<(event: Lease.Event) => void>;

    #sockets: Leases.SocketPool;

    constructor(options: Lease.Options) {
      this.#logger = options.logger.namespace(`Lease(${options.id}/${options.processId})`);
      this.#processId = options.processId;
      this.#supervisor = options.id;
      this.#state = Lease.State.Online;
      this.#timer = null;

      this.#subscribers = new Set();

      this.#sockets = new Leases.SocketPool({
        logger: this.#logger,
        max: options.maxSockets,
      });
    }

    get processId() {
      return this.#processId;
    }

    get supervisor() {
      return this.#supervisor;
    }

    get state() {
      return this.#state;
    }

    get online() {
      return this.#state === Lease.State.Online;
    }

    get expiring() {
      return this.#state === Lease.State.Expiring;
    }

    get destroyed() {
      return this.#state === Lease.State.Destroyed;
    }

    get sockets() {
      return this.#sockets;
    }

    notifyAssignmentListChanged() {
      for (const subscriber of this.#subscribers) {
        try {
          subscriber({ type: "assignment-list-changed" });
        } catch (error) {
          this.#logger.error("Lease change listener failed", { err: error, supervisor: this.#supervisor });
        }
      }
    }

    revive() {
      if (this.#state === Lease.State.Destroyed) {
        return;
      }

      if (this.#timer) {
        clearTimeout(this.#timer);

        this.#timer = null;
      }

      this.#state = Lease.State.Online;
    }

    expire() {
      if (this.#state !== Lease.State.Online) {
        return;
      }

      this.#state = Lease.State.Expiring;
      this.#timer = setTimeout(() => this.destroy(), LEASE_EXPIRE_COUNTDOWN_MS);
      this.#timer.unref?.();
    }

    destroy() {
      if (this.#state === Lease.State.Destroyed) {
        return;
      }

      if (this.#timer) {
        clearTimeout(this.#timer);

        this.#timer = null;
      }

      this.#state = Lease.State.Destroyed;

      // Destroy every socket managed by this lease via its socket pool.
      this.#sockets.destroy();

      for (const subscriber of this.#subscribers) {
        try {
          subscriber({ type: "destroyed" });
        } catch (error) {
          this.#logger.error("Lease change listener failed", { err: error, supervisor: this.#supervisor });
        }
      }

      this.#subscribers.clear();
    }

    subscribe(subscriber: (event: Lease.Event) => void) {
      this.#subscribers.add(subscriber);

      return () => {
        this.#subscribers.delete(subscriber);
      };
    }
  }

  export namespace Lease {
    export enum State {
      Online = "ONLINE",
      Expiring = "EXPIRING",
      Destroyed = "DESTROYED",
    }

    export type Event =
      | {
          type: "assignment-list-changed";
        }
      | {
          type: "destroyed";
        };

    export type Options = {
      id: string;
      processId: string;
      logger: Logger;
      maxSockets?: number;
    };
  }

  export class Exception extends Error {
    #code: Exception.Code;

    constructor(code: Exception.Code, message: string) {
      super(message);

      this.#code = code;
    }

    get code() {
      return this.#code;
    }
  }

  export namespace Exception {
    export enum Code {
      LeaseConflict = "LEASE_CONFLICT",
    }
  }
}
