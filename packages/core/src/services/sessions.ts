// ---------------------------------------------------------------------------
// SessionsService: cookie-session lifecycle (create/validate/touch/revoke).
// - Only the SHA-256 hash of the session id is stored; the raw sid travels
//   in the cookie only, so a DB read alone never yields a session.
// - CSRF tokens are derived deterministically from (sid, signing key) and
//   never persisted: concurrent tabs and repeat /me calls stay consistent.
// - validate() enforces three independent ends of life: explicit revocation,
//   absolute expiry, and idle timeout from last_active_at. All compare with
//   Date.now() so clock skew fails closed toward logout, not extension.
// - Token comparison is timing-safe; cleanup only deletes rows dead >1 day
//   so recent forensics survive logout.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { SessionRecord } from "@proxvm/shared";
import { AppError } from "../util/errors.js";
import { newId, nowIso } from "../util/misc.js";
import { randomToken, timingSafeEqualStr } from "../crypto/cipher.js";
import { deriveCsrfKey, deriveCsrfToken } from "../crypto/csrf.js";

export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface ActiveSession {
  id: string;
  sid: string;
  userId: string;
  csrfToken: string;
  expiresAt: Date;
  idleTimeoutMinutes: number;
}

/** Creates + validates cookie sessions; owns the sid-hash + CSRF derivation. */
export class SessionsService {
  private readonly csrfKey: Buffer;

  constructor(
    private readonly db: Pool,
    private readonly sessionDurationHours: number,
    private readonly idleTimeoutMinutes: number,
    sessionSigningKey: string,
  ) {
    this.csrfKey = deriveCsrfKey(sessionSigningKey);
  }

  async create(userId: string, meta: SessionMeta): Promise<ActiveSession> {
    const sid = randomToken(32);
    // CSRF tokens are derived from the session id, never stored: the plaintext
    // secret therefore never exists at rest, and every request presenting the
    // same cookie deterministically derives the same token (concurrent tabs).
    const csrfToken = deriveCsrfToken(sid, this.csrfKey);
    const record: SessionRecord = {
      id: newId(),
      sidHash: hashSid(sid),
      userId,
      csrfToken,
      expiresAt: new Date(Date.now() + this.sessionDurationHours * 3600 * 1000),
      lastActiveAt: new Date(),
      idleTimeoutMinutes: this.idleTimeoutMinutes,
      ip: meta.ip,
      userAgent: meta.userAgent,
      createdAt: new Date(),
      revokedAt: null,
    };
    await this.db.query(
      `INSERT INTO sessions (id, sid_hash, user_id, expires_at, last_active_at,
        idle_timeout_minutes, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.id,
        record.sidHash,
        record.userId,
        record.expiresAt,
        record.lastActiveAt,
        record.idleTimeoutMinutes,
        record.ip,
        record.userAgent,
      ],
    );
    return {
      id: record.id,
      sid,
      userId: record.userId,
      csrfToken: record.csrfToken,
      expiresAt: record.expiresAt,
      idleTimeoutMinutes: record.idleTimeoutMinutes,
    };
  }

  // -- Validation: revocation + absolute expiry + idle window -----------
  async validate(sid: string): Promise<SessionRecord | null> {
    const record = await this.findBySid(sid);
    if (!record) return null;
    if (record.revokedAt) return null;
    if (record.expiresAt.getTime() <= Date.now()) return null;
    const idleLimit = Date.now() - record.idleTimeoutMinutes * 60 * 1000;
    if (record.lastActiveAt.getTime() < idleLimit) return null;
    return record;
  }

  async findBySid(sid: string): Promise<SessionRecord | null> {
    const result = await this.db.query<{
      id: string;
      sid_hash: string;
      user_id: string;
      expires_at: Date;
      last_active_at: Date;
      idle_timeout_minutes: number;
      ip: string | null;
      user_agent: string | null;
      created_at: Date;
      revoked_at: Date | null;
    }>("SELECT * FROM sessions WHERE sid_hash = $1", [hashSid(sid)]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      sidHash: row.sid_hash,
      userId: row.user_id,
      // Derived, not stored: deterministic for this session id so idempotent
      // /me and concurrent tabs all observe the same token.
      csrfToken: deriveCsrfToken(sid, this.csrfKey),
      expiresAt: row.expires_at,
      lastActiveAt: row.last_active_at,
      idleTimeoutMinutes: row.idle_timeout_minutes,
      ip: row.ip,
      userAgent: row.user_agent,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  // -- Revocation / retention: logout paths + dead-row sweeper ----------
  async touch(sessionId: string): Promise<void> {
    await this.db.query("UPDATE sessions SET last_active_at = NOW() WHERE id = $1", [sessionId]);
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.query("UPDATE sessions SET revoked_at = NOW() WHERE id = $1", [sessionId]);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.query(
      "UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
      [userId],
    );
  }

  async cleanup(): Promise<void> {
    await this.db.query(
      "DELETE FROM sessions WHERE expires_at < NOW() - interval '1 day' OR revoked_at < NOW() - interval '1 day'",
    );
  }
}

/** SHA-256 of the raw sid; the only session identifier stored at rest. */
export function hashSid(sid: string): string {
  return createHash("sha256").update(sid, "utf8").digest("hex");
}

/** Timing-safe CSRF check; missing or mismatched tokens are 403. */
export function checkCsrf(expected: string, provided: string | undefined): void {
  if (!provided) throw AppError.forbidden("CSRF token missing");
  if (!timingSafeEqualStr(expected, provided)) throw AppError.forbidden("CSRF token mismatch");
}

export function sessionExpiryIso(expiresAt: Date): string {
  return nowIso();
}

export function csrfTokenOf(record: SessionRecord): string {
  return record.csrfToken;
}