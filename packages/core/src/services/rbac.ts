// ---------------------------------------------------------------------------
// Legacy system-role permissions (ADMIN / OPERATOR / USER).
//
// These hardcoded sets are the FAST PATH inside requirePermission: zero
// queries, evaluated from the already-loaded session user. Anything richer
// (custom roles, group roles, direct grants, expiries) lives in services/
// iam.ts and is resolved against the database instead.
//
// CRITICAL INVARIANT for reviewers: hasPermission/isAdmin read
// user.roles, which UsersService populates EXPIRED-FILTERED
// (expires_at IS NULL OR > NOW()). An expired ADMIN grant therefore
// vanishes from these checks with no extra code — but ONLY because the
// loader filters. If you ever populate UserWithRoles from another source,
// filter expiries there too or expired admins come back to life.
// ---------------------------------------------------------------------------
import type { Role, UserWithRoles } from "@proxvm/shared";
import { ROLES } from "@proxvm/shared";

export const ROLE_IDS: Record<Role, string> = {
  ADMIN: "00000000-0000-0000-0000-000000000001",
  OPERATOR: "00000000-0000-0000-0000-000000000002",
  USER: "00000000-0000-0000-0000-000000000003",
};

export const PERMISSIONS = [
  "vm.list",
  "vm.read",
  "vm.create",
  "vm.manage",
  "vm.edit",
  "vm.delete",
  "vm.provision",
  // Fine-grained VM actions. Routes accept these as alternatives to the
  // broader legacy permissions (e.g. start accepts vm.manage OR vm.start),
  // so grants only ever widen access for holders and never narrow existing
  // roles (which do not hold these codes).
  "vm.start",
  "vm.stop",
  "vm.restart",
  "cred.reveal",
  "cred.rotate",
  "guac.launch",
  "guac.manage",
  // Global protocol grants: may use this protocol on any accessible VM.
  // Enforced by the launch path alongside per-VM protocol scoping.
  "protocol.ssh",
  "protocol.rdp",
  "protocol.vnc",
  "users.manage",
  // IAM administration. Only ADMIN holds these (ADMIN = all PERMISSIONS).
  "roles.manage",
  "groups.manage",
  "templates.manage",
  "audit.read",
  "jobs.read",
  "jobs.retry",
  "jobs.cancel",
  "settings.manage",
  "health.read",
  "proxmox.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  ADMIN: new Set<Permission>(PERMISSIONS),
  OPERATOR: new Set<Permission>([
    "vm.list",
    "vm.read",
    "vm.create",
    "vm.manage",
    "vm.edit",
    "vm.provision",
    "cred.rotate",
    "guac.launch",
    "guac.manage",
    "jobs.read",
    "jobs.retry",
    "jobs.cancel",
    "health.read",
    "proxmox.read",
  ]),
  USER: new Set<Permission>([
    "vm.read",
    "guac.launch",
    "jobs.read",
    "health.read",
  ]),
};

export function permissionsForRole(role: Role): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role];
}

/**
 * Legacy fast-path check. Inactive users are denied even with live grants
 * (disablement must win over every permission source).
 */
export function hasPermission(user: UserWithRoles | null, permission: Permission): boolean {
  if (!user || !user.active) return false;
  return user.roles.some((role) => permissionsForRole(role).has(permission));
}

/** See the file header: roles here are already expiry-filtered by the loader. */
export function isAdmin(user: UserWithRoles | null): boolean {
  return !!user && user.roles.includes("ADMIN");
}

export function validRoles(roles: string[]): Role[] {
  return roles.filter((r): r is Role => (ROLES as readonly string[]).includes(r));
}