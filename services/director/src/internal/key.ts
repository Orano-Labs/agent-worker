import { generateKeyPair, verify } from "node:crypto";

export class Key {
  async generateED25519() {
    return await new Promise<[Buffer, Buffer]>((resolve, reject) => {
      const options = {
        publicKeyEncoding: { type: Key.ENCODINGS.PUBLIC_KEY, format: Key.FORMAT },
        privateKeyEncoding: { type: Key.ENCODINGS.PRIVATE_KEY, format: Key.FORMAT },
      };

      generateKeyPair(Key.TYPE, options, (error, publicKey, privateKey) => {
        if (error) {
          return reject(error);
        }

        return resolve([publicKey, privateKey]);
      });
    });
  }

  verifyED25519(key: Buffer, payload: Buffer, signature: Buffer) {
    return verify(undefined, payload, key, signature);
  }
}

export namespace Key {
  export const FORMAT = "der" as const;
  export const TYPE = "ed25519" as const;

  export const ENCODINGS = {
    PUBLIC_KEY: "spki",
    PRIVATE_KEY: "pkcs8",
  } as const;
}
