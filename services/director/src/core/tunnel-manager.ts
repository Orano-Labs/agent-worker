import type { Duplex } from "node:stream";
import { Tunnel } from "@/core/tunnel";

export class TunnelManager {
  #tunnels: Map<string, Tunnel>;

  constructor() {
    this.#tunnels = new Map();
  }

  create(project: string, token: string) {
    if (this.#tunnels.has(project)) {
      throw new Error(`Tunnel for project "${project}" already exists. Delete the existing tunnel first.`);
    }

    const tunnel = new Tunnel(project, token);

    // Clean up when the tunnel goes permanently offline (all sockets closed).
    tunnel.once("offline", () => {
      this.#tunnels.delete(project);
    });

    this.#tunnels.set(project, tunnel);

    return tunnel;
  }

  delete(project: string) {
    const tunnel = this.#tunnels.get(project);

    if (!tunnel) {
      return;
    }

    tunnel.destroy();

    this.#tunnels.delete(project);
  }

  get(project: string) {
    return this.#tunnels.get(project);
  }

  createTunnelConnection(project: string, token: string, socket: Duplex) {
    const tunnel = this.#tunnels.get(project);

    if (!tunnel) {
      return {
        status: 404,
        message: `Tunnel for project "${project}" not found`,
      };
    }

    if (tunnel.token !== token) {
      return {
        status: 403,
        message: "Invalid tunnel token",
      };
    }

    return tunnel.connect(socket);
  }
}
