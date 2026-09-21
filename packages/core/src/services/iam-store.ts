import { isUuid, newId } from "../util/misc.js";
import type { Queryable } from "../db/pool.js";
import { isLive, roleEffectivePermissions } from "./iam.js";
import type { RoleRow } from "./iam.js";

export interface PermissionEntry {
  code: string;
  category: string;
  description: string;
  scope: string;
}

export interface RoleDetail extends RoleRow {
  permissions: string[];
  userCount: number;
  groupCount: number;
}

export interface GroupRow {
  id: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: Date;
}

export async function listPermissions(db: Queryable): Promise<PermissionEntry[]> {
  const result = await db.query<PermissionEntry>(
    "SELECT code, category, description, scope FROM permissions ORDER BY category ASC, code ASC",
  );
  return result.rows;
}

export async function listRoles(db: Queryable): Promise<RoleDetail[]> {
  const roles = await db.query<RoleRow>(
    "SELECT id, name, description, is_system FROM roles ORDER BY name ASC",
  );
  const out: RoleDetail[] = [];
  for (const role of roles.rows) {
    const perms = await db.query<{ permission: string }>(
      "SELECT permission FROM role_permissions WHERE role_id = $1 ORDER BY permission ASC",
      [role.id],
    );
    const users = await db.query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM user_roles WHERE role_id = $1",
      [role.id],
    );
    const groups = await db.query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM group_roles WHERE role_id = $1",
      [role.id],
    );
    out.push({
      ...role,
      permissions: perms.rows.map((p) => p.permission),
      userCount: Number(users.rows[0]?.c ?? "0"),
      groupCount: Number(groups.rows[0]?.c ?? "0"),
    });
  }
  return out;
}

export async function getRole(db: Queryable, id: string): Promise<RoleDetail | null> {
  if (!isUuid(id)) return null;
  const roles = await db.query<RoleRow>(
    "SELECT id, name, description, is_system FROM roles WHERE id = $1",
    [id],
  );
  const role = roles.rows[0];
  if (!role) return null;
  const perms = await db.query<{ permission: string }>(
    "SELECT permission FROM role_permissions WHERE role_id = $1 ORDER BY permission ASC",
    [id],
  );
  const users = await db.query<{ c: string }>(
    "SELECT COUNT(*)::text AS c FROM user_roles WHERE role_id = $1",
    [id],
  );
  const groups = await db.query<{ c: string }>(
    "SELECT COUNT(*)::text AS c FROM group_roles WHERE role_id = $1",
    [id],
  );
  return {
    ...role,
    permissions: perms.rows.map((p) => p.permission),
    userCount: Number(users.rows[0]?.c ?? "0"),
    groupCount: Number(groups.rows[0]?.c ?? "0"),
  };
}

export async function findRoleByName(db: Queryable, name: string): Promise<RoleRow | null> {
  const result = await db.query<RoleRow>(
    "SELECT id, name, description, is_system FROM roles WHERE name = $1",
    [name],
  );
  return result.rows[0] ?? null;
}

export async function createRole(
  db: Queryable,
  input: { name: string; description?: string; permissions: string[] },
): Promise<RoleRow> {
  const id = newId();
  await db.query("INSERT INTO roles (id, name, description, is_system) VALUES ($1, $2, $3, false)", [
    id,
    input.name,
    input.description ?? "",
  ]);
  for (const permission of [...new Set(input.permissions)]) {
    await db.query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      id,
      permission,
    ]);
  }
  const created = await getRole(db, id);
  if (!created) throw new Error("Role creation failed");
  return created;
}

export async function setRolePermissions(db: Queryable, roleId: string, permissions: string[]): Promise<void> {
  await db.query("DELETE FROM role_permissions WHERE role_id = $1", [roleId]);
  for (const permission of [...new Set(permissions)]) {
    await db.query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      roleId,
      permission,
    ]);
  }
}

export async function updateRole(
  db: Queryable,
  id: string,
  input: { name?: string; description?: string },
): Promise<RoleRow | null> {
  const role = await getRole(db, id);
  if (!role) return null;
  await db.query(
    `UPDATE roles SET name = COALESCE($2, name), description = COALESCE($3, description)
      WHERE id = $1`,
    [id, input.name ?? null, input.description ?? null],
  );
  return getRole(db, id);
}

export async function deleteRole(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query("DELETE FROM roles WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

export interface GroupDetail extends GroupRow {
  memberCount: number;
  roleCount: number;
  vmCount: number;
}

export async function listGroups(db: Queryable): Promise<GroupDetail[]> {
  const groups = await db.query<GroupRow>("SELECT * FROM groups ORDER BY name ASC");
  const out: GroupDetail[] = [];
  for (const group of groups.rows) {
    out.push(await enrichGroup(db, group));
  }
  return out;
}

export async function getGroup(db: Queryable, id: string): Promise<GroupDetail | null> {
  if (!isUuid(id)) return null;
  const groups = await db.query<GroupRow>("SELECT * FROM groups WHERE id = $1", [id]);
  const group = groups.rows[0];
  if (!group) return null;
  return enrichGroup(db, group);
}

async function enrichGroup(db: Queryable, group: GroupRow): Promise<GroupDetail> {
  const members = await db.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM group_members WHERE group_id = $1", [
    group.id,
  ]);
  const roles = await db.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM group_roles WHERE group_id = $1", [
    group.id,
  ]);
  const vms = await db.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM group_vm_access WHERE group_id = $1", [
    group.id,
  ]);
  return {
    ...group,
    memberCount: Number(members.rows[0]?.c ?? "0"),
    roleCount: Number(roles.rows[0]?.c ?? "0"),
    vmCount: Number(vms.rows[0]?.c ?? "0"),
  };
}

export async function findGroupByName(db: Queryable, name: string): Promise<GroupRow | null> {
  const result = await db.query<GroupRow>("SELECT * FROM groups WHERE name = $1", [name]);
  return result.rows[0] ?? null;
}

export async function createGroup(
  db: Queryable,
  input: { name: string; description?: string; createdBy?: string | null },
): Promise<GroupRow> {
  const id = newId();
  await db.query("INSERT INTO groups (id, name, description, created_by) VALUES ($1, $2, $3, $4)", [
    id,
    input.name,
    input.description ?? "",
    input.createdBy ?? null,
  ]);
  const created = await getGroup(db, id);
  if (!created) throw new Error("Group creation failed");
  return created;
}

export async function groupMembers(db: Queryable, groupId: string): Promise<
  Array<{ userId: string; username: string; expiresAt: Date | null; createdAt: Date }>
> {
  if (!isUuid(groupId)) return [];
  const result = await db.query<{
    user_id: string;
    username: string;
    expires_at: Date | null;
    created_at: Date;
  }>(
    `SELECT gm.user_id, u.username, gm.expires_at, gm.created_at
      FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = $1 ORDER BY u.username ASC`,
    [groupId],
  );
  return result.rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }));
}

export async function groupRoles(db: Queryable, groupId: string): Promise<
  Array<{ roleId: string; roleName: string; expiresAt: Date | null }>
> {
  if (!isUuid(groupId)) return [];
  const result = await db.query<{ role_id: string; role_name: string; expires_at: Date | null }>(
    `SELECT gr.role_id, r.name AS role_name, gr.expires_at
      FROM group_roles gr JOIN roles r ON r.id = gr.role_id
      WHERE gr.group_id = $1 ORDER BY r.name ASC`,
    [groupId],
  );
  return result.rows.map((r) => ({ roleId: r.role_id, roleName: r.role_name, expiresAt: r.expires_at }));
}

export interface GroupPermissionEntry extends PermissionEntry {
  /** Role names (linked to the group) that confer this permission. */
  roles: string[];
}

/**
 * Union of permissions conferred by a group's roles, with provenance.
 * Handles legacy roles (hardcoded sets) and custom roles (stored rows) via
 * roleEffectivePermissions; expired group_roles links are ignored, matching
 * authorization resolution. Ordered like the permission catalog.
 */
export async function groupEffectivePermissions(
  db: Queryable,
  groupId: string,
): Promise<GroupPermissionEntry[]> {
  if (!isUuid(groupId)) return [];
  const links = await db.query<{ role_id: string; role_name: string; expires_at: Date | null }>(
    `SELECT gr.role_id, r.name AS role_name, gr.expires_at
       FROM group_roles gr JOIN roles r ON r.id = gr.role_id
       WHERE gr.group_id = $1 ORDER BY r.name ASC`,
    [groupId],
  );
  const byPermission = new Map<string, Set<string>>();
  for (const link of links.rows) {
    if (!isLive(link.expires_at)) continue;
    for (const code of await roleEffectivePermissions(db, link.role_id)) {
      const holders = byPermission.get(code) ?? new Set<string>();
      holders.add(link.role_name);
      byPermission.set(code, holders);
    }
  }
  const catalog = await listPermissions(db);
  return catalog
    .filter((entry) => byPermission.has(entry.code))
    .map((entry) => ({ ...entry, roles: [...(byPermission.get(entry.code) ?? [])].sort() }));
}

export async function groupVms(db: Queryable, groupId: string): Promise<
  Array<{ vmId: string; vmName: string; vmid: number; node: string; protocols: string[] | null; expiresAt: Date | null }>
> {
  if (!isUuid(groupId)) return [];
  const result = await db.query<{
    vm_id: string;
    vm_name: string;
    vmid: number;
    node: string;
    protocols: string[] | null;
    expires_at: Date | null;
  }>(
    `SELECT gva.vm_id, v.name AS vm_name, v.vmid, v.node, gva.protocols, gva.expires_at
      FROM group_vm_access gva JOIN vms v ON v.id = gva.vm_id
      WHERE gva.group_id = $1 AND v.deleted_at IS NULL ORDER BY v.name ASC`,
    [groupId],
  );
  return result.rows.map((r) => ({
    vmId: r.vm_id,
    vmName: r.vm_name,
    vmid: Number(r.vmid),
    node: r.node,
    protocols: r.protocols,
    expiresAt: r.expires_at,
  }));
}
