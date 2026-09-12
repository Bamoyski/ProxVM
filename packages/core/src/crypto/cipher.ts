import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { AppError } from "../util/errors.js";

export const CIPHER = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function masterKeyFromHex(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new AppError("CONFIGURATION_ERROR", "Master key must be 32 raw bytes as hex", 500);
  }
  return Buffer.from(hex, "hex");
}

export interface EncryptedValue {
  keyId: string;
  ciphertext: string;
}

export function encryptSecret(masterKey: string, keyId: string, plaintext: string): EncryptedValue {
  const key = masterKeyFromHex(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(CIPHER, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, enc]);
  return { keyId, ciphertext: `${keyId}:${payload.toString("base64")}` };
}

export function decryptSecret(masterKey: string, stored: string): { keyId: string; plaintext: string } {
  const sep = stored.indexOf(":");
  if (sep <= 0) {
    throw new AppError("CONFIGURATION_ERROR", "Stored secret has an invalid format", 500);
  }
  const keyId = stored.slice(0, sep);
  const payload = Buffer.from(stored.slice(sep + 1), "base64");
  if (payload.length < IV_LENGTH + TAG_LENGTH) {
    throw new AppError("CONFIGURATION_ERROR", "Stored secret is truncated", 500);
  }
  const key = masterKeyFromHex(masterKey);
  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const enc = payload.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    return { keyId, plaintext };
  } catch {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "Failed to decrypt secret: wrong master key or corrupted data",
      500,
    );
  }
}

export function rotateSecretKey(
  oldMasterKey: string,
  newMasterKey: string,
  newKeyId: string,
  stored: string,
): EncryptedValue {
  const { plaintext } = decryptSecret(oldMasterKey, stored);
  return encryptSecret(newMasterKey, newKeyId, plaintext);
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}