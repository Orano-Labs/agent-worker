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
      this.delete(project);
    }

    const tunnel = new Tunnel(project, token, supervisor);

    tunnel.once("offline", () => {
      this.#logger.debug("Tunnel offline — removing from manager", { project });
    });

    this.#tunnels.set(project, tunnel);
    this.#logger.debug("Tunnel registered in manager", { project, supervisor });

    return tunnel;
  }

  delete(project: string) {
    const tunnel = this.#tunnels.get(project);

    if (!tunnel) {
      return this.#logger.debug("Tunnel not found for deletion", { project });
    }

    this.#logger.debug("Deleting tunnel", { project });
    this.#tunnels.delete(project);

    tunnel.destroy();
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
