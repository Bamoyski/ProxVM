import { createHmac, hkdfSync } from "node:crypto";

/**
 * Deterministic, stateless CSRF tokens.
 *
 * The token is derived from the session's original random session id (the
 * opaque value carried in the session cookie), never from the hashed database
 * id and never stored. This means the plaintext token never exists at rest, yet
 * every request that presents the same cookie derives the same token, so
 * concurrent browser tabs keep working.
 *
 * Key management:
 * - The subkey is derived from the dedicated `sessionSigningKey` (an unrelated
 *   per-install secret; never the AES master key) with HKDF-SHA256.
 * - `CSRF_SUBKEY_INFO` provides domain separation from every other use of the
 *   signing key, and `CSRF_TOKEN_DOMAIN` prevents a token from being computed
 *   over anything but a session id.
 */
const CSRF_SUBKEY_INFO = "proxvm:session-csrf-subkey:v1";
const CSRF_TOKEN_DOMAIN = "proxvm:csrf:v1:";

/** Derives the 32-byte CSRF MAC subkey from the session signing key. */
export function deriveCsrfKey(sessionSigningKey: string): Buffer {
  const key = hkdfSync(
    "sha256",
    Buffer.from(sessionSigningKey, "utf8"),
    Buffer.alloc(0),
    Buffer.from(CSRF_SUBKEY_INFO, "utf8"),
    32,
  );
  return Buffer.from(key);
}

/**
 * Computes the CSRF token for a session. `sid` is the original random session
 * id from the cookie (not the hashed value stored in the database).
 */
export function deriveCsrfToken(sid: string, csrfKey: Buffer): string {
  return createHmac("sha256", csrfKey).update(CSRF_TOKEN_DOMAIN + sid, "utf8").digest("hex");
}
