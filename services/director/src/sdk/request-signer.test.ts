import { fromBinary } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { SignatureIdentitySchema, SignatureSchema } from "@/generated/proto/api/v1/signature_pb";
import { Key } from "@/internal/key";
import { RequestSigner } from "@/sdk/request-signer";

const toHex = (source: Uint8Array) => source.reduce((str, byte) => str + byte.toString(16).padStart(2, "0"), "");

/** Decodes a production signature and guarantees the required fields are present. */
const decodeSignature = (value: string) => {
  const message = fromBinary(SignatureSchema, Buffer.from(value, "base64"));
  const payload = message.payload;

  if (!payload?.timestamp) {
    throw new Error("Signature payload is missing required fields");
  }

  return {
    nonce: payload.nonce,
    timestamp: payload.timestamp,
    identity: payload.identity,
    signature: message.signature,
  };
};

describe("RequestSigner", () => {
  it("decodes the production signature and verifies it with Ed25519 (manager)", async () => {
    const key = new Key();
    const [publicKey, privateKey] = await key.generateED25519();
    const signer = new RequestSigner({ type: "manager", privateKey: toHex(privateKey) });

    const { nonce, timestamp, identity, signature } = decodeSignature(await signer.generate());

    expect(nonce).toHaveLength(32);
    expect(identity?.identity?.case).toBe("manager");
    expect(signature).toHaveLength(64);

    const unixSeconds = Math.floor(timestampDate(timestamp).getTime() / 1000);
    const payload = `${toHex(nonce)}:${unixSeconds}`;

    expect(key.verifyED25519(publicKey, Buffer.from(payload), Buffer.from(signature))).toBe(true);
  });

  it("includes the user id in the signed payload (user/supervisor)", async () => {
    const key = new Key();
    const [publicKey, privateKey] = await key.generateED25519();
    const id = "123456789012345678901234";
    const signer = new RequestSigner({ type: "user", id, privateKey: toHex(privateKey) });

    const { nonce, timestamp, identity, signature } = decodeSignature(await signer.generate());

    if (identity?.identity?.case !== "user") {
      throw new Error("Expected user identity");
    }

    expect(identity.identity.value.id).toBe(id);

    const unixSeconds = Math.floor(timestampDate(timestamp).getTime() / 1000);
    const payload = `${toHex(nonce)}:${unixSeconds}:${id}`;

    expect(key.verifyED25519(publicKey, Buffer.from(payload), Buffer.from(signature))).toBe(true);
  });

  it("decodes the development signature as SignatureIdentity", async () => {
    const key = new Key();
    const [, privateKey] = await key.generateED25519();
    const signer = new RequestSigner({ type: "supervisor", id: "123456789012345678901234", privateKey: toHex(privateKey) });

    const message = fromBinary(SignatureIdentitySchema, Buffer.from(await signer.generateDev(), "base64"));

    expect(message.identity?.case).toBe("supervisor");
  });

  it("apply writes the matching header based on the dev flag", async () => {
    const key = new Key();
    const [, privateKey] = await key.generateED25519();
    const seedHex = toHex(privateKey);

    const production = new RequestSigner({ type: "manager", privateKey: seedHex });
    const headers = new Headers();

    await production.apply(headers);

    expect(headers.get("x-request-signature")).toBeTruthy();
    expect(headers.get("x-request-signature-development")).toBeNull();

    const development = new RequestSigner({ type: "manager", privateKey: seedHex }, true);
    const devHeaders = new Headers();

    await development.apply(devHeaders);

    expect(devHeaders.get("x-request-signature-development")).toBeTruthy();
    expect(devHeaders.get("x-request-signature")).toBeNull();
  });
});
