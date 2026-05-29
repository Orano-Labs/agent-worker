import { createPrivateKey, sign } from "node:crypto";

import { default as PartySocket } from "partysocket";
import { default as WebSocket } from "ws";
import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

export class Director {
  #logger: Logger;
  #cli: CommandLine;
  #variables: Variables;

  #ws!: PartySocket;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Director");
    this.#cli = Container.inject(CommandLine);
    this.#variables = Container.inject(Variables);
  }

  async init() {
    const id = this.#variables.get("AW_SUPERVISOR_ID");
    const key = this.#variables.get("AW_SUPERVISOR_PRIVATE_KEY");
    const url = this.#variables.get("AW_SUPERVISOR_DIRECTOR_HOST_URL");

    if (!id || !key || !url) {
      const missing: string[] = [];

      if (!id) missing.push("AW_SUPERVISOR_ID");
      if (!key) missing.push("AW_SUPERVISOR_PRIVATE_KEY");
      if (!url) missing.push("AW_SUPERVISOR_DIRECTOR_HOST_URL");

      this.#logger.error(`Missing required environment variables: [${missing.join(", ")}].`);

      return process.exit(1);
    }

    try {
      const parsed = new URL(url);

      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        this.#logger.error(`Director host URL must use 'ws:' or 'wss:' protocol. Received: '${parsed.protocol}'`);

        return process.exit(1);
      }
    } catch {
      this.#logger.error(`Invalid URL configuration: '${url}' is not a valid URL. Please check AW_SUPERVISOR_DIRECTOR_HOST_URL.`);

      return process.exit(1);
    }

    let privateKey: ReturnType<typeof createPrivateKey>;

    try {
      privateKey = createPrivateKey({
        key: Buffer.from(key, "hex"),
        format: "der",
        type: "pkcs8",
      });
    } catch (error) {
      this.#logger.errorFrom(error, "Ensure 'AW_SUPERVISOR_PRIVATE_KEY' is a valid hex-encoded PKCS#8 DER key.");

      return process.exit(1);
    }

    this.#logger.info("Supervisor director client initialized successfully.", {
      id: id,
    });

    const self = this;

    this.#ws = new PartySocket({
      host: url,
      basePath: "supervisor/join",
      WebSocket: class extends WebSocket {
        constructor(url: string) {
          const timestamp = Date.now().toString();
          const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
          const payload = `${id}\n${timestamp}\n${nonce}`;
          const signature = sign(undefined, Buffer.from(payload), privateKey);

          const headers = {
            "x-supervisor-id": id,
            "x-timestamp": timestamp,
            "x-nonce": nonce,
            "x-signature": signature.toString("hex"),
          };

          self.#logger.info(`Connecting to director: ${url}`, {
            headers: { ...headers, "x-signature": `${headers["x-signature"].substring(0, 8)}...` },
          });

          super(url, {
            headers,
          });
        }
      },
    });

    this.#ws.reconnect();

    this.#ws.addEventListener("error", (error) => {
      this.#logger.errorFrom(error, "WebSocket encountered an error");
    });

    this.#ws.addEventListener("open", () => {
      this.#logger.info("WebSocket connection established successfully.");
    });

    this.#ws.addEventListener("message", (event) => {
      console.log(event.data);
      this.#ws.send("");
    });
  }
}
