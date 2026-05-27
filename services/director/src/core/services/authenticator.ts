import { createHmac, createPrivateKey, createPublicKey, generateKeyPair, verify } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { eq } from "drizzle-orm";
import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Database } from "@/internal/database";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

export class Authenticator {
  #logger: Logger;
  #cli: CommandLine;
  #variables: Variables;
  #db: Database;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Authenticator");
    this.#cli = Container.inject(CommandLine);
    this.#variables = Container.inject(Variables);
    this.#db = Container.inject(Database);
  }

  async authenticateSupervisorConnect(request: IncomingMessage) {
    // const secret = this.#variables.get("AW_DIRECTOR_MASTYER_SECRET");

    // if (!secret) {
    //   throw new Authenticator.AuthenticationError("");
    // }

    // const headers = {
    //   id: request.headers["x-supervisor-id"],
    //   timestamp: request.headers["x-timestamp"],
    //   nonce: request.headers["x-nonce"],
    //   signature: request.headers["x-signature"],
    // };

    // const stringToSign = `${headers.id}\n${headers.timestamp}\n${headers.nonce}`;

    // verify()

    // if (!header) {
    //   throw new Authenticator.AuthenticationError("");
    // }

    // const row = await this.#db.client
    //   .select()
    //   .from(this.#db.schema.SUPERVISIORS_TABLE)
    //   .where(eq(this.#db.schema.SUPERVISIORS_TABLE.publicKey, hashed))
    //   .then((rows) => {
    //     return rows[0];
    //   });

    // if (!row) {
    //   throw new Authenticator.AuthenticationError("");
    // }

    return { id: "" } as Authenticator.SupervisorCredentials;
  }

  async generateSupervisorKeyPair() {
    return new Promise<{ publicKey: Buffer; privateKey: Buffer }>((resolve, reject) => {
      generateKeyPair(
        "ed25519",
        {
          publicKeyEncoding: { type: "spki", format: "der" },
          privateKeyEncoding: { type: "pkcs8", format: "der" },
        },
        (error, publicKey, privateKey) => {
          if (error) {
            return reject(error);
          }

          return resolve({ publicKey, privateKey });
        },
      );
    });
  }

  exportSupervisorKey(type: "public" | "private", key: Buffer) {
    if (type === "public") {
      return createPublicKey({ key, type: "spki", format: "der" }).export({
        type: "spki",
        format: "pem",
      });
    } else {
      return createPrivateKey({ key, type: "pkcs8", format: "der" }).export({
        type: "pkcs8",
        format: "pem",
      });
    }
  }
}

export namespace Authenticator {
  export type SupervisorCredentials = {
    id: string;
  };

  export class AuthenticationError extends Error {}
}
