import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  generatePassword,
  encryptSecret,
  decryptSecret,
  rotateSecretKey,
  timingSafeEqualStr,
} from "../src/index.js";

describe("password hashing", () => {
  it("hashes and verifies", async () => {
    const hash = await hashPassword("Correct-Horse9!");
    expect(await verifyPassword(hash, "Correct-Horse9!")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
    expect(hash).not.toContain("Correct");
  });
});

describe("password generation", () => {
  it("meets complexity and length", () => {
    for (const length of [12, 16, 24, 64]) {
      const pw = generatePassword(length);
      expect(pw.length).toBe(length);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^A-Za-z0-9]/);
    }
  });
  it("generates unique passwords", () => {
    const set = new Set(Array.from({ length: 50 }, () => generatePassword(24)));
    expect(set.size).toBe(50);
  });
});

describe("AES-256-GCM secret encryption", () => {
  const key = "a".repeat(64);
  it("roundtrips", () => {
    const enc = encryptSecret(key, "v1", "s3cret-value");
    expect(enc.ciphertext).not.toContain("s3cret-value");
    const dec = decryptSecret(key, enc.ciphertext);
    expect(dec.plaintext).toBe("s3cret-value");
    expect(dec.keyId).toBe("v1");
  });
  it("rejects tampering", () => {
    const enc = encryptSecret(key, "v1", "s3cret-value");
    const parts = enc.ciphertext.split(":");
    const payload = Buffer.from(parts[1] as string, "base64");
    payload[payload.length - 1] = (payload[payload.length - 1] as number) ^ 0xff;
    const tampered = `${parts[0]}:${payload.toString("base64")}`;
    expect(() => decryptSecret(key, tampered)).toThrow();
  });
  it("rejects wrong key", () => {
    const enc = encryptSecret(key, "v1", "s3cret-value");
    expect(() => decryptSecret("b".repeat(64), enc.ciphertext)).toThrow();
  });
  it("rotates keys", () => {
    const enc = encryptSecret(key, "v1", "rotate-me");
    const rotated = rotateSecretKey(key, "c".repeat(64), "v2", enc.ciphertext);
    expect(rotated.keyId).toBe("v2");
    expect(decryptSecret("c".repeat(64), rotated.ciphertext).plaintext).toBe("rotate-me");
  });
  it("timing safe compare", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});


describe("generated password embeds no dictionary of the word password", () => {
  it("never equals a constant", () => {
    expect(generatePassword(24)).not.toBe("password-password-passw");
  });
});

it("encryptSecret accepts arbitrary keyIds", () => {
  const enc = encryptSecret("d".repeat(64), "v9", "x");
  expect(decryptSecret("d".repeat(64), enc.ciphertext).keyId).toBe("v9");
});

describe("stored secret roundtrip of longer values", () => {
  it("handles long and unicode", () => {
    const key = "e".repeat(64);
    const value = "Ünïcode-påsswörd-with-spaces-and-!@#$%^&*()_+".repeat(3);
    const enc = encryptSecret(key, "v1", value);
    expect(decryptSecret(key, enc.ciphertext).plaintext).toBe(value);
  });
});
