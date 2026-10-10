import type { Socket } from "node:net";

export abstract class Tunnel {
  abstract upgrade(socket: Socket): Promise<void>;
}
