import type { Duplex } from "node:stream";
import { Tunnel } from "@/core/tunnel";
import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";

export class TunnelManager {
  #logger: Logger;
  #tunnels: Map<string, Tunnel>;

  constructor() {
    this.#logger = Container.inject(Logger).scope("TunnelManager");
    this.#tunnels = new Map();
  }

  create(project: string, token: string, supervisor: string) {
    if (this.#tunnels.has(project)) {
      this.#logger.debug("Tunnel already exists, refusing to create duplicate", { project });
      throw new Error(`Tunnel for project "${project}" already exists. Delete the existing tunnel first.`);
    }

    const tunnel = new Tunnel(project, token, supervisor);

    // Clean up when the tunnel goes permanently offline (all sockets closed).
    tunnel.once("offline", () => {
      this.#logger.debug("Tunnel offline — removing from manager", { project });
      this.#tunnels.delete(project);
    });

    this.#tunnels.set(project, tunnel);
    this.#logger.debug("Tunnel registered in manager", { project, supervisor });

    return tunnel;
  }

  delete(project: string) {
    const tunnel = this.#tunnels.get(project);

    if (!tunnel) {
      this.#logger.debug("Tunnel not found for deletion", { project });
      return;
    }

    this.#logger.debug("Deleting tunnel", { project });
    tunnel.destroy();

    this.#tunnels.delete(project);
  }

  get(project: string) {
    return this.#tunnels.get(project);
  }

  createTunnelConnection(project: string, token: string, socket: Duplex) {
    const tunnel = this.#tunnels.get(project);

    if (!tunnel) {
      this.#logger.debug("Tunnel not found for connection", { project });

      return {
        status: 404,
        message: `Tunnel for project "${project}" not found`,
      };
    }

    if (tunnel.token !== token) {
      this.#logger.debug("Invalid token for tunnel connection", { project });
      return {
        status: 403,
        message: "Invalid tunnel token",
      };
    }

    this.#logger.debug("Creating tunnel socket connection", { project });

    return tunnel.connect(socket);
  }
}
