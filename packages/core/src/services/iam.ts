import type { Protocol } from "@proxvm/shared";
import { AppError } from "../util/errors.js";
import { isUuid } from "../util/misc.js";
import { permissionsForRole } from "./rbac.js";
import type { Queryable } from "../db/pool.js";
import type { GuacamoleService } from "./guacamole.js";
import type { GuacamoleDbClient } from "../guacamole/db.js";
import type { VmsRepository } from "./vms.js";
import type { AuditService } from "./audit.js";
import type { Logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Permission precedence model (allow-only union, default deny).
//
// Everything below is additive; there is deliberately NO explicit-deny
// semantic (simpler to represent in the DB/API/UI and impossible to
// misconfigure into lockout):
//
//   direct grant  \  (union — any live source allows)
//   custom role   ---/
//   group role    ---/
//   legacy system role (ADMIN/OPERATOR/USER hardcoded sets)
//
// For protocols, specific beats general instead of pure union: an explicit
// per-VM protocol list wins for that VM; global protocol.* grants scope
// otherwise-unscoped access; with neither, all protocols are allowed.
//
//   default: deny.
//
// Expiration is authoritative: any grant whose expires_at has passed is
// ignored by resolution (no background job required for denial), while a
// periodic sweep revokes leftover Guacamole permissions and prunes rows.
// ---------------------------------------------------------------------------

export const KNOWN_PROTOCOLS: ReadonlySet<string> = new Set(["ssh", "rdp", "vnc"]);

export function isLive(expiresAt: Date | string | null | undefined, now = new Date()): boolean {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() > now.getTime();
}

export function sanitizeProtocols(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const out = [...new Set(value.filter((p): p is string => typeof p === "string" && KNOWN_PROTOCOLS.has(p)))];
  return out;
}

export interface VmAccessGrant {
  protocols: string[] | null; // null = all protocols
  expiresAt: Date | null;
  sources: string[];
}

export interface EffectiveAccess {
  /** global permission -> human-readable source labels */
  permissions: Map<string, string[]>;
  /** vmId -> merged access */
  vmAccess: Map<string, VmAccessGrant>;
  roles: string[];
  groups: Array<{ id: string; name: string }>;
}

export interface RoleRow {
  id: string;
  name: string;
  description: string;
  is_system: boolean;
}

export async function resolveEffectiveAccess(db: Queryable, userId: string): Promise<EffectiveAccess> {
  const now = new Date();
  const permissions = new Map<string, string[]>();
  const vmAccess = new Map<string, VmAccessGrant>();
  const addPerm = (perm: string, source: string): void => {
    const list = permissions.get(perm) ?? [];
    if (!list.includes(source)) list.push(source);
    permissions.set(perm, list);
  };
  const addVmAccess = (vmId: string, protocols: string[] | null, expiresAt: Date | null, source: string): void => {
    const cur = vmAccess.get(vmId);
    if (!cur) {
      vmAccess.set(vmId, { protocols, expiresAt, sources: [source] });
      return;
    }
    // Union semantics: null (all) absorbs anything; otherwise merge lists.
    if (cur.protocols === null || protocols === null) {
      cur.protocols = null;
    } else {
      cur.protocols = [...new Set([...cur.protocols, ...protocols])];
    }
    if (!cur.sources.includes(source)) cur.sources.push(source);
    if (!cur.expiresAt || (expiresAt && new Date(expiresAt) > new Date(cur.expiresAt))) {
      cur.expiresAt = expiresAt;
    }
  };

  // 1. Roles (direct + expiry) -> legacy sets + custom role_permissions.
  const rolesRes = await db.query<{ id: string; name: string; expires_at: Date | null }>(
    `SELECT r.id, r.name, ur.expires_at FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [userId],
  );
  const liveRoles = rolesRes.rows.filter((r) => isLive(r.expires_at, now));
  const roles = liveRoles.map((r) => r.name);
  for (const role of liveRoles) {
    if (role.name === "ADMIN" || role.name === "OPERATOR" || role.name === "USER") {
      for (const p of permissionsForRole(role.name as "ADMIN" | "OPERATOR" | "USER")) {
        addPerm(p, `role:${role.name}`);
      }
    }
  }
  if (liveRoles.length) {
    const rp = await db.query<{ role_name: string; permission: string }>(
      `SELECT r.name AS role_name, rp.permission FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id
        JOIN user_roles ur ON ur.role_id = r.id
        WHERE ur.user_id = $1 AND (ur.expires_at IS NULL OR ur.expires_at > NOW())`,
      [userId],
    );
    for (const row of rp.rows) addPerm(row.permission, `role:${row.role_name}`);
  }

  // 2. Direct global grants.
  const direct = await db.query<{ permission: string; expires_at: Date | null }>(
    `SELECT permission, expires_at FROM user_permissions
      WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [userId],
  );
  for (const row of direct.rows) addPerm(row.permission, "direct grant");

  // 3. Groups: memberships -> group roles -> role_permissions; group VM access.
  const groupsRes = await db.query<{ id: string; name: string; expires_at: Date | null }>(
    `SELECT g.id, g.name, gm.expires_at FROM group_members gm
      JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = $1 AND (gm.expires_at IS NULL OR gm.expires_at > NOW())`,
    [userId],
  );
  const groups = groupsRes.rows.map((g) => ({ id: g.id, name: g.name }));
  if (groups.length) {
    // NOTE: IN-list is built dynamically instead of = ANY($1) because array
    // parameters behave inconsistently across pg drivers and pg-mem.
    const placeholders = groups.map((_, i) => `$${i + 1}`).join(", ");
    const groupIds = groups.map((g) => g.id);
    const gr = await db.query<{ group_name: string; role_name: string; permission: string }>(
      `SELECT g.name AS group_name, r.name AS role_name, rp.permission
        FROM group_roles gr
        JOIN groups g ON g.id = gr.group_id
        JOIN roles r ON r.id = gr.role_id
        JOIN role_permissions rp ON rp.role_id = r.id
        WHERE gr.group_id IN (${placeholders})
          AND (gr.expires_at IS NULL OR gr.expires_at > NOW())`,
      groupIds,
    );
    for (const row of gr.rows) addPerm(row.permission, `group role:${row.role_name} via ${row.group_name}`);

    const gva = await db.query<{ vm_id: string; protocols: string[] | null; expires_at: Date | null; group_name: string }>(
      `SELECT gva.vm_id, gva.protocols, gva.expires_at, g.name AS group_name
        FROM group_vm_access gva JOIN groups g ON g.id = gva.group_id
        WHERE gva.group_id IN (${placeholders})
          AND (gva.expires_at IS NULL OR gva.expires_at > NOW())`,
      groupIds,
    );
    for (const row of gva.rows) {
      addVmAccess(row.vm_id, sanitizeProtocols(row.protocols), row.expires_at, `group ${row.group_name}`);
    }
  }

  // 4. Direct VM access (unexpired only).
  const dva = await db.query<{ vm_id: string; protocols: string[] | null; expires_at: Date | null }>(
    `SELECT vm_id, protocols, expires_at FROM vm_access
      WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [userId],
  );
  for (const row of dva.rows) {
    addVmAccess(row.vm_id, sanitizeProtocols(row.protocols), row.expires_at, "direct VM access");
  }

  return { permissions, vmAccess, roles, groups };
}

export type AccessReason =
  | "ok"
  | "inactive_user"
  | "missing_permission"
  | "missing_vm_access"
  | "access_expired"
  | "protocol_denied";

export interface AccessCheck {
  allowed: boolean;
  reason: AccessReason;
  permission?: string;
  sources?: string[];
}

/**
 * Authoritative check used by routes and the explanation API. Never throws
 * for denials — it returns a safe, non-sensitive reason instead.
 */
export async function checkAccess(
  db: Queryable,
  user: { id: string; username: string; active: boolean; roles: string[] },
  opts: { permission?: string; vmId?: string; protocol?: Protocol | string },
): Promise<AccessCheck> {
  if (!user.active) return { allowed: false, reason: "inactive_user" };
  if (opts.vmId && !isUuid(opts.vmId)) return { allowed: false, reason: "missing_vm_access", permission: opts.permission };
  const effective = await resolveEffectiveAccess(db, user.id);

  if (opts.permission && !effective.permissions.has(opts.permission)) {
    return { allowed: false, reason: "missing_permission", permission: opts.permission };
  }
  const sources = opts.permission ? (effective.permissions.get(opts.permission) ?? []) : [];

  if (opts.vmId) {
    const grant = effective.vmAccess.get(opts.vmId);
    if (!grant) {
      // Distinguish "had access but it expired" for better UX/audit.
      const expired = await db.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM vm_access WHERE vm_id = $1 AND user_id = $2 AND expires_at IS NOT NULL AND expires_at <= NOW()`,
        [opts.vmId, user.id],
      );
      if (Number(expired.rows[0]?.c ?? "0") > 0) {
        return { allowed: false, reason: "access_expired", permission: opts.permission, sources };
      }
      return { allowed: false, reason: "missing_vm_access", permission: opts.permission, sources };
    }
    if (opts.protocol) {
      const allowed = allowedProtocols(effective, opts.vmId);
      if (allowed !== null && !allowed.includes(opts.protocol)) {
        return { allowed: false, reason: "protocol_denied", permission: opts.permission, sources };
      }
    }
  } else if (opts.protocol) {
    // Global protocol grant without a VM context (used by matrix/UI checks).
    if (!effective.permissions.has(`protocol.${opts.protocol}`)) {
      return { allowed: false, reason: "protocol_denied", permission: opts.permission, sources };
    }
  }
  return { allowed: true, reason: "ok", permission: opts.permission, sources };
}

/**
 * Effective protocols for a VM: null = all connections allowed.
 *
 * Specific beats general: an explicit per-VM protocol list (from direct or
 * group VM access, unioned at the same specificity level) is authoritative
 * for that VM. Global protocol.* grants only scope otherwise-unscoped
 * (legacy, protocols NULL) access. With neither, all protocols are allowed,
 * preserving pre-IAM behavior exactly.
 */
export function allowedProtocols(effective: EffectiveAccess, vmId: string): string[] | null {
  const grant = effective.vmAccess.get(vmId);
  if (!grant) return [];
  if (grant.protocols !== null) return [...grant.protocols];
  const globals = [...effective.permissions.keys()]
    .filter((p) => p.startsWith("protocol."))
    .map((p) => p.slice("protocol.".length))
    .filter((p) => KNOWN_PROTOCOLS.has(p));
  if (globals.length === 0) return null;
  return globals;
}

export interface ReconcileDeps {
  vms: VmsRepository;
  guac: GuacamoleService;
  getGuacDb: () => Promise<GuacamoleDbClient>;
  audit: AuditService;
  logger: Logger;
}

export interface SweepDeps extends ReconcileDeps {
  db: Queryable;
}

/**
 * Reconcile a user's Guacamole permissions for one VM with their effective
 * ProxVM access: revoke everything for the VM, then grant exactly the
 * effective protocol set. Idempotent; safe to call after any membership,
 * grant, expiry or deletion change.
 */
export async function reconcileUserVmGuacAccess(
  deps: SweepDeps,
  userId: string,
  vmId: string,
): Promise<{ protocols: string[] | null }> {
  const effective = await resolveEffectiveAccess(deps.db, userId);
  const grant = effective.vmAccess.get(vmId);
  const guacDb = await deps.getGuacDb();
  await deps.guac.revokeVmAccess(vmId, userId, guacDb);
  if (!grant) return { protocols: [] };
  const allowed = allowedProtocols(effective, vmId);
  const records = await deps.guac.listConnectionRecords(vmId);
  const userRecord = await deps.guac.findUserRecord(userId);
  if (userRecord) {
    for (const record of records) {
      if (allowed === null || allowed.includes(record.protocol)) {
        await guacDb.grantConnectionRead(record.guac_connection_name, userRecord.guac_username);
      }
    }
  }
  return { protocols: allowed };
}

/**
 * Sweep expired VM access (direct + group): revoke Guacamole permissions,
 * delete the rows, audit each expiration. Best-effort per row so one broken
 * VM never blocks the rest. Authorization itself never depends on this —
 * resolution ignores expired rows regardless.
 */
export async function sweepExpiredVmAccess(
  deps: SweepDeps,
  db?: Queryable,
): Promise<{ revoked: number; errors: number }> {
  const q: Queryable = db ?? deps.db;
  let revoked = 0;
  let errors = 0;
  const stale = await q.query<{ vm_id: string; user_id: string; username: string; kind: string }>(
    `SELECT va.vm_id, va.user_id, u.username, 'direct' AS kind FROM vm_access va
      JOIN users u ON u.id = va.user_id
      WHERE va.expires_at IS NOT NULL AND va.expires_at <= NOW()
     UNION
     SELECT gva.vm_id, gm.user_id, u.username, 'group' AS kind
      FROM group_vm_access gva
      JOIN group_members gm ON gm.group_id = gva.group_id
      JOIN users u ON u.id = gm.user_id
      WHERE (gva.expires_at IS NOT NULL AND gva.expires_at <= NOW())
         OR (gm.expires_at IS NOT NULL AND gm.expires_at <= NOW())`,
  );
  // Deduplicate (user, vm) pairs; group rows are pruned separately below.
  const seen = new Set<string>();
  for (const row of stale.rows) {
    const key = `${row.vm_id}:${row.user_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const guacDb = await deps.getGuacDb();
      await deps.guac.revokeVmAccess(row.vm_id, row.user_id, guacDb);
      await q.query("DELETE FROM vm_access WHERE vm_id = $1 AND user_id = $2 AND expires_at IS NOT NULL AND expires_at <= NOW()", [
        row.vm_id,
        row.user_id,
      ]);
      await deps.audit.record({
        event: "TEMPORARY_ACCESS_EXPIRED",
        vmId: row.vm_id,
        detail: { userId: row.user_id, username: row.username, via: row.kind },
      });
      revoked += 1;
    } catch (err) {
      errors += 1;
      deps.logger.warn(
        { vmId: row.vm_id, userId: row.user_id, error: err instanceof Error ? err.message : String(err) },
        "failed to sweep expired VM access",
      );
    }
  }
  // Prune expired group rows/memberships/grants themselves (resolution
  // already ignores them; Guac perms for affected users were revoked above).
  // Expired user_roles rows are kept as history; resolution ignores them.
  await q.query("DELETE FROM group_vm_access WHERE expires_at IS NOT NULL AND expires_at <= NOW()");
  await q.query("DELETE FROM group_members WHERE expires_at IS NOT NULL AND expires_at <= NOW()");
  await q.query("DELETE FROM group_roles WHERE expires_at IS NOT NULL AND expires_at <= NOW()");
  await q.query("DELETE FROM user_permissions WHERE expires_at IS NOT NULL AND expires_at <= NOW()");
  return { revoked, errors };
}

export function requireSystemRoleProtection(role: RoleRow, action: string): void {
  if (role.is_system) {
    throw AppError.forbidden(`System role "${role.name}" is protected from ${action}`);
  }
}

/** All permissions a role confers: hardcoded sets for legacy roles, stored rows otherwise. */
export async function roleEffectivePermissions(db: Queryable, roleId: string): Promise<Set<string>> {
  const roles = await db.query<{ name: string }>("SELECT name FROM roles WHERE id = $1", [roleId]);
  const name = roles.rows[0]?.name;
  if (!name) throw AppError.notFound("Role not found");
  if (name === "ADMIN" || name === "OPERATOR" || name === "USER") {
    return new Set<string>(permissionsForRole(name));
  }
  const rows = await db.query<{ permission: string }>(
    "SELECT permission FROM role_permissions WHERE role_id = $1",
    [roleId],
  );
  return new Set(rows.rows.map((r) => r.permission));
}

/**
 * Conferral rule: an actor may only put into circulation (via role/permission
 * grants) permissions they themselves currently hold. ADMIN holds everything
 * so admins are never blocked.
 */
export async function assertMayConfer(
  db: Queryable,
  actor: { id: string; username: string },
  permissions: Iterable<string>,
): Promise<void> {
  const actorEffective = await resolveEffectiveAccess(db, actor.id);
  const missing = [...new Set(permissions)].filter((p) => !actorEffective.permissions.has(p));
  if (missing.length) {
    throw AppError.forbidden(
      `You cannot grant permission(s) you do not possess: ${missing.join(", ")}`,
    );
  }
}

/**
 * Target rule: an actor may only mutate IAM state of users whose effective
 * permission set is a subset of their own. Prevents a lesser-privileged
 * user-administrator from resetting an admin's password, stripping an
 * admin's grants (lockout), or otherwise operating upward. Self-service is
 * governed by the conferral rule and the existing self-harm guards instead.
 */
export async function assertCanAdministerTarget(
  db: Queryable,
  actor: { id: string; username: string },
  targetUserId: string,
): Promise<void> {
  if (actor.id === targetUserId) return;
  const [actorEffective, targetEffective] = await Promise.all([
    resolveEffectiveAccess(db, actor.id),
    resolveEffectiveAccess(db, targetUserId),
  ]);
  const overreach = [...targetEffective.permissions.keys()].filter((p) => !actorEffective.permissions.has(p));
  if (overreach.length) {
    throw AppError.forbidden("Target user holds permissions you do not possess");
  }
}
