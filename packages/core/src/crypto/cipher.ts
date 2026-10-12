/* ---------------------------------------------------------------------------
 * cipher.ts — symmetric encryption for stored secrets (VM + Guacamole creds).
 *
 * All secrets are sealed with AES-256-GCM under a single deployment master
 * key (32 raw bytes as hex). The keyId prefix on every ciphertext is routing
 * metadata only: it selects which key decrypts, never a substitute for auth.
 * SECURITY: decrypt failures intentionally return one generic message so a
 * wrong key and corrupted data are indistinguishable to callers.
 * ------------------------------------------------------------------------- */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { AppError } from "../util/errors.js";

export const CIPHER = "aes-256-gcm";
// WHY 12-byte IV: the NIST-recommended GCM nonce size; other sizes force an
// extra GHASH pass and weaken interop. Fresh per encryption via randomBytes.
const IV_LENGTH = 12;
// WHY 16 bytes: the full GCM auth tag. Truncating would trade forgery
// resistance for a few bytes with no benefit here.
const TAG_LENGTH = 16;

/** Parse + validate the deployment master key (32 raw bytes, hex-encoded). */
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

// --- Encryption -----------------------------------------------------------
/**
 * Seal one plaintext under the master key.
 * Layout is iv || tag || ciphertext (base64), prefixed with `keyId:` so
 * rotation can tell which key sealed each row without trial-decrypting.
 */
export function encryptSecret(masterKey: string, keyId: string, plaintext: string): EncryptedValue {
  const key = masterKeyFromHex(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(CIPHER, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, enc]);
  return { keyId, ciphertext: `${keyId}:${payload.toString("base64")}` };
}

/**
 * Open a value sealed by encryptSecret. Throws CONFIGURATION_ERROR (never the
 * raw crypto error) so stack traces and messages can't leak key material.
 */
export function decryptSecret(masterKey: string, stored: string): { keyId: string; plaintext: string } {
  const sep = stored.indexOf(":");
  if (sep <= 0) {
    throw new AppError("CONFIGURATION_ERROR", "Stored secret has an invalid format", 500);
  }
  const keyId = stored.slice(0, sep);
  const payload = Buffer.from(stored.slice(sep + 1), "base64");
  // WHY pre-check length: avoids slicing nonsense and gives a "truncated"
  // diagnosis instead of a cryptic GCM auth failure further down.
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
    // WHY one generic message: distinguishing "wrong key" from "corrupt row"
    // would let an attacker oracle the master key byte-by-byte via rotation.
    throw new AppError(
      "CONFIGURATION_ERROR",
      "Failed to decrypt secret: wrong master key or corrupted data",
      500,
    );
  }
}

// --- Key rotation + misc helpers -------------------------------------------
/**
 * Re-seal a stored secret under a new master key (decrypt with old, encrypt
 * with new). Plaintext lives only in memory for the duration of the call.
 */
export function rotateSecretKey(
  oldMasterKey: string,
  newMasterKey: string,
  newKeyId: string,
  stored: string,
): EncryptedValue {
  const { plaintext } = decryptSecret(oldMasterKey, stored);
  return encryptSecret(newMasterKey, newKeyId, plaintext);
}

/**
 * Constant-time string compare for non-hashed secrets (tokens, CSRF values).
 * WHY the length short-circuit: timingSafeEqual throws on unequal lengths,
 * so mismatch must return false first; length itself is not secret here.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Mint a random hex token (session/CSRF/share-link entropy source).
 * WHY 32 bytes default: 256 bits leaves brute force infeasible even if the
 * token's lifetime or rate limiting is misconfigured elsewhere.
 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}