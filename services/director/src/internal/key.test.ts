import { createPrivateKey, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Key } from "@/internal/key";

describe("Key", () => {
  it("generates a pair of DER-encoded Ed25519 keys", async () => {
    const key = new Key();
    const [publicKey, privateKey] = await key.generateED25519();

    expect(publicKey).toBeInstanceOf(Buffer);
    expect(privateKey).toBeInstanceOf(Buffer);
    expect(publicKey.length).toBeGreaterThan(0);
    expect(privateKey.length).toBeGreaterThan(0);

    // The public key derived from the private key must equal the returned one (spki/der).
    const derived = createPublicKey(createPrivateKey({ key: privateKey, format: Key.FORMAT, type: Key.ENCODINGS.PRIVATE_KEY }));
    const derivedDer = derived.export({ type: Key.ENCODINGS.PUBLIC_KEY, format: Key.FORMAT });

    expect(Buffer.isBuffer(derivedDer) && derivedDer.equals(publicKey)).toBe(true);
  });

  it("signs a payload that verifyED25519 accepts", async () => {
    const key = new Key();
    const [publicKey, privateKey] = await key.generateED25519();
    const payload = Buffer.from("hello world");

    const signature = key.signED25519(privateKey, payload);

    expect(key.verifyED25519(publicKey, payload, signature)).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const key = new Key();
    const [publicKey, privateKey] = await key.generateED25519();
    const payload = Buffer.from("hello world");
    const signature = key.signED25519(privateKey, payload);

    expect(key.verifyED25519(publicKey, Buffer.from("tampered payload"), signature)).toBe(false);
  });

  it("rejects a signature produced by a different key", async () => {
    const key = new Key();
    const [publicKey] = await key.generateED25519();
    const [, otherPrivateKey] = await key.generateED25519();
    const payload = Buffer.from("hello world");
    const signature = key.signED25519(otherPrivateKey, payload);

    expect(key.verifyED25519(publicKey, payload, signature)).toBe(false);
  });

  it("rejects a random signature", async () => {
    const key = new Key();
    const [publicKey] = await key.generateED25519();
    const payload = Buffer.from("hello world");

    expect(key.verifyED25519(publicKey, payload, Buffer.alloc(64, 1))).toBe(false);
  });
});
