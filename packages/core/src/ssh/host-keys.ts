import { createHash } from "node:crypto";
import type { Queryable } from "../db/pool.js";
import type { Logger } from "../util/logger.js";
import type { AuditService } from "../services/audit.js";
import { newId } from "../util/misc.js";

/**
 * TOFU SSH host-key pinning.
 *
 * Trust model: the first SSH connection that authenticates successfully to a
 * scope (VM identity + endpoint) pins the SHA-256 fingerprint of the host key
 * that server presented. Every later connection must present the same key.
 * Nothing is trusted silently on first use: enrollment is deferred until after
 * user authentication succeeds (auth proves the endpoint really holds the
 * stored credential), and is recorded in the audit log. A failed auth never
 * enrolls; a connection whose key mismatches the pin never proceeds; a
 * verification-service failure fails closed. The only ways to change a pin are
 * the audited admin operations (rotate/unpin) in the API.
 */

export interface HostKeyRowLike {
  id: string;
  scope: string;
  vm_id: string | null;
  endpoint: string;
  fingerprint: string;
  key_type: string | null;
  enrolled_at: Date;
  updated_at: Date;
}

export interface HostKeyRecord {
  scope: string;
  vmId: string | null;
  endpoint: string;
  fingerprint: string;
  keyType: string | null;
  enrolledAt: Date;
  updatedAt: Date;
}

export interface HostKeyDecision {
  /** Accept the presented host key and let the connection proceed. */
  accept: boolean;
  /** True when a pin already existed at decision time (not a first connect). */
  alreadyEnrolled: boolean;
  detail?: string;
}

export interface HostKeyPolicy {
  /** Canonical uniqueness key: "vm:<uuid>@host:port" or "host:host:port". */
  scope: string;
  vmId: string | null;
  endpoint: string;
  /**
   * Called by the SSH client during key exchange, BEFORE authentication.
   * Rejects a pinned-but-mismatched key before any credential is sent, and
   * provisionally accepts an unpinned scope (commitment happens only after
   * authentication succeeds, via confirm()).
   */
  decide(fingerprint: string, keyType: string | null): Promise<HostKeyDecision>;
  /**
   * Called by the SSH client AFTER user authentication succeeded, for the key
   * this connection actually presented. Atomically enrolls a first connect
   * (INSERT ... ON CONFLICT DO NOTHING + re-read), and fails closed when a
   * concurrent first connect enrolled a different key or an admin rotated the
   * pin mid-handshake.
   */
  confirm(fingerprint: string, keyType: string | null): Promise<HostKeyDecision>;
}

export interface HostKeyServiceDeps {
  db: Queryable;
  audit?: AuditService;
  logger?: Logger;
}

export interface PolicyOptions {
  /** VM identity, when the SSH target is a managed VM. Null for VM-less probes. */
  vmId?: string | null;
  host: string;
  port?: number;
  /** Provisioning job attribution for enrollment/mismatch audit rows. */
  jobId?: string;
}

export interface SshHostKeyPattern {
  fingerprint: string;
  keyType: string | null;
  endpoint: string;
}

/** SHA-256 of a raw SSH host key blob, hex-encoded (matches ssh2's hostHash "sha256"). */
export function sha256Hex(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Reads the SSH-wire algorithm name (uint32 length + bytes) off a host key blob. */
export function keyTypeOf(key: Buffer): string | null {
  if (!Buffer.isBuffer(key) || key.length < 4) return null;
  const len = key.readUInt32BE(0);
  if (len <= 0 || len > key.length - 4) return null;
  try {
    return key.toString("utf8", 4, 4 + len);
  } catch {
    return null;
  }
}

/** Canonical, comparison-safe endpoint string: "host:port" with bare IPv6 bracketed. */
export function normalizeEndpoint(host: string, port?: number): string {
  const h = String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const wrapped = h.includes(":") ? `[${h}]` : h;
  return `${wrapped}:${Number.isInteger(port) ? port : 22}`;
}

/** Uniqueness scope: binds a pinned key to the VM identity AND the SSH endpoint. */
export function buildScope(opts: { vmId?: string | null; host: string; port?: number }): string {
  const endpoint = normalizeEndpoint(opts.host, opts.port);
  return (opts.vmId ? `vm:${opts.vmId}@${endpoint}` : `host:${endpoint}`) as string;
}

const HEX64 = /^[0-9a-f]{64}$/i;
const OPENSSH_B64 = /^SHA256:([A-Za-z0-9+/]+={0,2})$/i;

/**
 * Accepts a canoniciSH 64-hex sha256 fingerprint, or an OpenSSH-formatted
 * "SHA256:<base64>" fingerprint (as printed by `ssh-keygen -lf`), and returns
 * the canonical hex form. Null when the input is not a recognizable sha256
 * fingerprint — callers then fail closed rather than guessing.
 */
export function normalizeFingerprint(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (HEX64.test(raw)) return raw.toLowerCase();
  const m = OPENSSH_B64.exec(raw);
  if (!m) return null;
  try {
    const bytes = Buffer.from(m[1] ?? "", "base64");
    if (bytes.length !== 32) return null;
    return bytes.toString("hex");
  } catch {
    return null;
  }
}

export class HostKeyService {
  constructor(private readonly deps: HostKeyServiceDeps) {}

  policy(opts: PolicyOptions): HostKeyPolicy {
    const scope = buildScope(opts);
    const endpoint = normalizeEndpoint(opts.host, opts.port);
    const vmId = opts.vmId ?? null;
    const svc = this;
    return {
      scope,
      vmId,
      endpoint,
      decide: (fingerprint, keyType) => svc.decide(scope, endpoint, vmId, opts.jobId ?? null, fingerprint, keyType),
      confirm: (fingerprint, keyType) => svc.confirm(scope, endpoint, vmId, opts.jobId ?? null, fingerprint, keyType),
    };
  }

  read(opts: { scope?: string; vmId?: string; endpoint?: string }): Promise<HostKeyRecord | null> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.scope) {
      params.push(opts.scope);
      conditions.push(`scope = $${params.length}`);
    }
    if (opts.vmId) {
      params.push(opts.vmId);
      conditions.push(`vm_id = $${params.length}`);
    }
    if (opts.endpoint) {
      params.push(opts.endpoint);
      conditions.push(`endpoint = $${params.length}`);
    }
    if (!conditions.length) return Promise.resolve(null);
    // NOTE: read() intentionally propagates datastore errors. Swallowing them
    // to null would make an unpinned lookup look like a first connect and let
    // decide() accept an unknown key while the DB is unreachable (fail open).
    // decide()/confirm() wrap this in try/catch and fail closed instead.
    return this.deps.db
      .query<HostKeyRowLike>(`SELECT * FROM ssh_host_keys WHERE ${conditions.join(" AND ")} LIMIT 1`, params)
      .then((r) => (r.rows[0] ? toRecord(r.rows[0]) : null));
  }

  async listForVm(vmId: string): Promise<HostKeyRecord[]> {
    const result = await this.deps.db.query<HostKeyRowLike>(
      "SELECT * FROM ssh_host_keys WHERE vm_id = $1 ORDER BY endpoint ASC",
      [vmId],
    );
    return result.rows.map(toRecord);
  }

  /**
   * Audit-only admin "re-verify the host" action: set the pinned fingerprint
   * to a value the operator verified out-of-band (e.g. from the proxmox
   * console `ssh-keygen -lf`) after a legitimate rebuild or host-key rotation.
   * Requires a recognizable sha256 fingerprint; returns null (no-op, no audit)
   * when no pin exists yet.
   */
  async setFingerprint(
    opts: PolicyOptions & { fingerprint: string; actorUserId?: string | null; actorUsername?: string | null },
  ): Promise<HostKeyRecord | null> {
    const fingerprint = normalizeFingerprint(opts.fingerprint);
    if (!fingerprint) {
      throw new TypeError(
        `"${opts.fingerprint}" is not a recognized SSH host-key fingerprint. Paste a 64-char hex sha256 value or an OpenSSH-formatted "SHA256:..." value.`,
      );
    }
    const scope = buildScope(opts);
    const endpoint = normalizeEndpoint(opts.host, opts.port);
    const keyType = null;
    const vmId = opts.vmId ?? null;
    const result = await this.deps.db.query<HostKeyRowLike>(
      `UPDATE ssh_host_keys
         SET fingerprint = $2, key_type = $3, updated_at = NOW()
       WHERE scope = $1
       RETURNING *`,
      [scope, fingerprint, keyType],
    );
    const current = result.rows[0] ? toRecord(result.rows[0]) : await this.read({ scope });
    if (!current) return null;
    await this.recordAudit("SSH_HOST_KEY_ROTATED", {
      vmId,
      actorUserId: opts.actorUserId ?? null,
      actorUsername: opts.actorUsername ?? null,
      detail: { endpoint, previous: current.fingerprint, fingerprint, reason: "admin-verified" },
    });
    return current;
  }

  /**
   * Audit-only admin action: drop the pin so the next successfully
   * authenticated connection re-enrolls (TOFU again). Used after a rebuild,
   * IP change, or when the operator confirms the host key changed
   * legitimately.
   */
  async unpin(
    opts: PolicyOptions & { actorUserId?: string | null; actorUsername?: string | null },
  ): Promise<boolean> {
    const scope = buildScope(opts);
    const endpoint = normalizeEndpoint(opts.host, opts.port);
    const vmId = opts.vmId ?? null;
    const existing = await this.read({ scope });
    if (!existing) return false;
    await this.deps.db.query("DELETE FROM ssh_host_keys WHERE scope = $1", [scope]);
    await this.recordAudit("SSH_HOST_KEY_UNPINNED", {
      vmId,
      actorUserId: opts.actorUserId ?? null,
      actorUsername: opts.actorUsername ?? null,
      detail: { endpoint, fingerprint: existing.fingerprint },
    });
    return true;
  }

  /**
   * KEX-time check. Never throws: a verification failure returns accept:false
   * so the connection is aborted before credentials are exchanged.
   */
  private async decide(
    scope: string,
    endpoint: string,
    vmId: string | null,
    jobId: string | null,
    fingerprint: string,
    keyType: string | null,
  ): Promise<HostKeyDecision> {
    try {
      const row = await this.read({ scope });
      if (!row) return { accept: true, alreadyEnrolled: false };
      if (row.fingerprint === fingerprint) return { accept: true, alreadyEnrolled: true };
      await this.recordMismatch(scope, endpoint, vmId, jobId, row.fingerprint, fingerprint);
      return {
        accept: false,
        alreadyEnrolled: true,
        detail: mismatchMessage(endpoint, row.fingerprint, fingerprint),
      };
    } catch (err) {
      this.deps.logger?.error({ err: err instanceof Error ? err.message : String(err) }, "host-key decision failed; failing closed");
      return { accept: false, alreadyEnrolled: false, detail: "SSH host key could not be verified (internal error)" };
    }
  }

  /**
   * Post-auth commitment. Atomically enrolls a first connect and then confirms
   * the stored pin still matches what this connection presented. Fails closed
   * on concurrent-enrollment conflicts and on any DB error.
   */
  private async confirm(
    scope: string,
    endpoint: string,
    vmId: string | null,
    jobId: string | null,
    fingerprint: string,
    keyType: string | null,
  ): Promise<HostKeyDecision> {
    try {
      const before = await this.read({ scope });
      if (before && before.fingerprint === fingerprint) return { accept: true, alreadyEnrolled: true };
      if (before && before.fingerprint !== fingerprint) {
        await this.recordMismatch(scope, endpoint, vmId, jobId, before.fingerprint, fingerprint);
        return { accept: false, alreadyEnrolled: true, detail: mismatchMessage(endpoint, before.fingerprint, fingerprint) };
      }
      // First connect: atomic claim. One concurrent connection wins the row;
      // exact-key races are harmless (both pins equal), different-key races
      // fail the loser.
      await this.deps.db.query(
        `INSERT INTO ssh_host_keys (id, scope, vm_id, endpoint, fingerprint, key_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (scope) DO NOTHING`,
        [newId(), scope, vmId, endpoint, fingerprint, keyType],
      );
      const after = await this.read({ scope });
      if (!after) {
        throw new Error("host key pin vanished during enrollment");
      }
      if (after.fingerprint !== fingerprint) {
        await this.recordMismatch(scope, endpoint, vmId, jobId, after.fingerprint, fingerprint);
        return { accept: false, alreadyEnrolled: true, detail: mismatchMessage(endpoint, after.fingerprint, fingerprint) };
      }
      await this.recordAudit("SSH_HOST_KEY_ENROLLED", {
        vmId,
        jobId,
        detail: { endpoint, fingerprint, keyType: keyType ?? null },
      });
      return { accept: true, alreadyEnrolled: false };
    } catch (err) {
      this.deps.logger?.error({ err: err instanceof Error ? err.message : String(err) }, "host-key enrollment failed; failing closed");
      return { accept: false, alreadyEnrolled: false, detail: "SSH host key could not be recorded (internal error)" };
    }
  }

  private async recordMismatch(
    scope: string,
    endpoint: string,
    vmId: string | null,
    jobId: string | null,
    expected: string,
    presented: string,
  ): Promise<void> {
    await this.recordAudit("SSH_HOST_KEY_MISMATCH", {
      vmId,
      jobId,
      detail: { scope, endpoint, expected, presented, blocked: true },
    });
    this.deps.logger?.warn({ scope, endpoint, vmId, jobId }, "SSH host key mismatch; connection rejected");
  }

  private async recordAudit(
    event: "SSH_HOST_KEY_ENROLLED" | "SSH_HOST_KEY_MISMATCH" | "SSH_HOST_KEY_ROTATED" | "SSH_HOST_KEY_UNPINNED",
    entry: {
      vmId?: string | null;
      jobId?: string | null;
      actorUserId?: string | null;
      actorUsername?: string | null;
      detail: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!this.deps.audit) return;
    await this.deps.audit
      .record({
        event,
        actorUserId: entry.actorUserId ?? null,
        actorUsername: entry.actorUsername ?? null,
        vmId: entry.vmId ?? null,
        jobId: entry.jobId ?? null,
        detail: entry.detail,
      })
      .catch((err) => {
        this.deps.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, `failed to record audit event ${event}`);
      });
  }
}

function toRecord(row: HostKeyRowLike): HostKeyRecord {
  return {
    scope: row.scope,
    vmId: row.vm_id,
    endpoint: row.endpoint,
    fingerprint: row.fingerprint,
    keyType: row.key_type,
    enrolledAt: row.enrolled_at,
    updatedAt: row.updated_at,
  };
}

function mismatchMessage(endpoint: string, expected: string, presented: string): string {
  return (
    `SSH host key for ${endpoint} changed since it was trusted: expected sha256:${expected.slice(0, 12)}… but the server offered ` +
    `sha256:${presented.slice(0, 12)}…. This may be a man-in-the-middle attack or a legitimate guest rebuild / host-key ` +
    `rotation. An administrator must re-verify the host key before connections resume.`
  );
}