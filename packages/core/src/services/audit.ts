import type { Queryable } from "../db/pool.js";
import type { AuditEvent, AuditRecord } from "@proxvm/shared";
import { newId } from "../util/misc.js";
import { AppError } from "../util/errors.js";

export interface AuditEntryInput {
  event: AuditEvent;
  actorUserId?: string | null;
  actorUsername?: string | null;
  vmId?: string | null;
  jobId?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown> | null;
}

export class AuditService {
  constructor(private readonly db: Queryable) {}

  async record(entry: AuditEntryInput): Promise<void> {
    const safeDetail = entry.detail ? sanitizeDetail(entry.detail) : null;
    await this.db.query(
      `INSERT INTO audit_logs (id, event, actor_user_id, actor_username, vm_id, job_id, ip, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        newId(),
        entry.event,
        entry.actorUserId ?? null,
        entry.actorUsername ?? null,
        entry.vmId ?? null,
        entry.jobId ?? null,
        entry.ip ?? null,
        safeDetail ? JSON.stringify(safeDetail) : null,
      ],
    );
  }

  async list(opts: {
    limit?: number;
    offset?: number;
    event?: string;
    vmId?: string;
    actorUserId?: string | null;
    actorUsername?: string;
    ip?: string;
    since?: Date;
    until?: Date;
  }): Promise<AuditRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.event) {
      params.push(opts.event);
      conditions.push(`event = $${params.length}`);
    }
    if (opts.vmId) {
      params.push(opts.vmId);
      conditions.push(`vm_id = $${params.length}`);
    }
    if (opts.actorUserId !== undefined) {
      params.push(opts.actorUserId);
      conditions.push(`actor_user_id = $${params.length}`);
    }
    if (opts.actorUsername) {
      // Backslash is the default LIKE escape in Postgres (no ESCAPE clause
      // needed; pg-mem cannot parse the explicit clause), so escapeLike()
      // output matches literally on both.
      params.push(`%${escapeLike(opts.actorUsername)}%`);
      conditions.push(`actor_username ILIKE $${params.length}`);
    }
    if (opts.ip) {
      params.push(opts.ip);
      conditions.push(`ip = $${params.length}`);
    }
    if (opts.since) {
      params.push(opts.since.toISOString());
      conditions.push(`created_at >= $${params.length}`);
    }
    if (opts.until) {
      params.push(opts.until.toISOString());
      conditions.push(`created_at <= $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(opts.limit ?? 50, opts.offset ?? 0);
    const result = await this.db.query<{
      id: string;
      event: AuditEvent;
      actor_user_id: string | null;
      actor_username: string | null;
      vm_id: string | null;
      job_id: string | null;
      ip: string | null;
      detail: unknown;
      created_at: Date;
    }>(
      `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return result.rows.map((r) => ({
      id: r.id,
      event: r.event,
      actorUserId: r.actor_user_id,
      actorUsername: r.actor_username,
      vmId: r.vm_id,
      jobId: r.job_id,
      ip: r.ip,
      detail: typeof r.detail === "object" ? (r.detail as Record<string, unknown>) : null,
      createdAt: r.created_at,
    }));
  }

  /** Delete entries older than the given retention window. Returns rows removed. */
  async prune(olderThanDays: number): Promise<number> {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
      throw AppError.validation("retention must be at least 1 day");
    }
    const result = await this.db.query(
      "DELETE FROM audit_logs WHERE created_at < NOW() - ($1 || ' days')::interval",
      [Math.floor(olderThanDays)],
    );
    return result.rowCount ?? 0;
  }
}

/** Escapes LIKE/ILIKE wildcards in user-supplied filter text. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const FORBIDDEN_DETAIL_KEYS = new Set([
  "password",
  "newPassword",
  "token",
  "tokenSecret",
  "secret",
  "masterKey",
  "sessionKey",
  "credentials",
  "authorization",
  "cookie",
  "authToken",
  "cipassword",
  "passthrough",
]);

const NORMALIZED_FORBIDDEN_KEYS = new Set(
  [...FORBIDDEN_DETAIL_KEYS].map((k) => k.toLowerCase().replace(/[_-]/g, "")),
);

const FORBIDDEN_SUBSTRINGS = [
  "password",
  "passwd",
  "token",
  "secret",
  "apikey",
  "privatekey",
  "passphrase",
  "sshkey",
  "credential",
];

function isSensitiveKey(key: string): boolean {
  // Normalized (case/punctuation-insensitive): "newPassword", "api_key"
  // and "apiKey" all reduce to a matchable form.
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return NORMALIZED_FORBIDDEN_KEYS.has(normalized) || FORBIDDEN_SUBSTRINGS.some((s) => normalized.includes(s));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 5) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, depth + 1));
  if (value !== null && typeof value === "object") {
    return sanitizeDetail(value as Record<string, unknown>, depth + 1);
  }
  return value;
}

function sanitizeDetail(detail: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (isSensitiveKey(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = sanitizeValue(value, depth);
  }
  return out;
}