import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import {
  AppError,
  assertCanAdministerTarget,
  assertMayConfer,
  checkAccess,
  createGroup,
  createRole,
  deleteRole,
  findGroupByName,
  findRoleByName,
  getGroup,
  getRole,
  groupMembers,
  groupRoles,
  groupVms,
  listGroups,
  listPermissions,
  listRoles,
  reconcileUserVmGuacAccess,
  requireSystemRoleProtection,
  resolveEffectiveAccess,
  roleEffectivePermissions,
  setRolePermissions,
  updateRole,
  type Permission,
} from "@proxvm/core";

const roleNameSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9 _-]+$/, "Invalid role name");
const groupNameSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9 _-]+$/, "Invalid group name");
const permissionSchema = z.string().min(1).max(64);
const expiresAtSchema = z.string().datetime({ offset: true }).optional();
const protocolsSchema = z.array(z.enum(["ssh", "rdp", "vnc"])).max(3).optional();

function parseExpiresAt(raw: string | undefined, field = "expiresAt"): Date | null {
  if (raw === undefined) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw AppError.validation(`${field} must be a future date-time`);
  }
  return date;
}

export async function iamRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;
  const rolesGuard = app.requirePermission("roles.manage");
  const groupsGuard = app.requirePermission("groups.manage");
  const usersGuard = app.requirePermission("users.manage");

  const reconcileDeps = {
    db: ctx.db,
    vms: ctx.vms,
    guac: ctx.guac,
    getGuacDb: () => ctx.getGuacDb(),
    audit: ctx.audit,
    logger: ctx.logger,
  };

  /** Best-effort Guacamole reconciliation: DB state is authoritative, so a
   *  Guac outage must never fail the management operation itself. */
  const reconcileVm = async (userId: string, vmId: string): Promise<void> => {
    try {
      await reconcileUserVmGuacAccess(reconcileDeps, userId, vmId);
    } catch (err) {
      ctx.logger.warn(
        { userId, vmId, error: err instanceof Error ? err.message : String(err) },
        "group access change could not sync Guacamole yet; launch self-heals",
      );
    }
  };

  const groupVmIds = async (groupId: string): Promise<string[]> => {
    const rows = await ctx.db.query<{ vm_id: string }>("SELECT vm_id FROM group_vm_access WHERE group_id = $1", [
      groupId,
    ]);
    return rows.rows.map((r) => r.vm_id);
  };

  const groupMemberIds = async (groupId: string): Promise<string[]> => {
    const rows = await ctx.db.query<{ user_id: string }>(
      `SELECT user_id FROM group_members WHERE group_id = $1
        AND (expires_at IS NULL OR expires_at > NOW())`,
      [groupId],
    );
    return rows.rows.map((r) => r.user_id);
  };

  // -- Catalog & self -------------------------------------------------------
  app.get("/iam/catalog", async (request) => {
    await app.requireAuth(request);
    return { permissions: await listPermissions(ctx.db) };
  });

  app.get("/iam/effective", async (request) => {
    const user = await app.requireAuth(request);
    const effective = await resolveEffectiveAccess(ctx.db, user.id);
    return {
      permissions: [...effective.permissions.entries()].map(([permission, sources]) => ({ permission, sources })),
      vmAccess: [...effective.vmAccess.entries()].map(([vmId, grant]) => ({ vmId, ...grant })),
      roles: effective.roles,
      groups: effective.groups,
    };
  });

  app.get("/authorization/check", async (request) => {
    const user = await app.requireAuth(request);
    const query = z
      .object({
        permission: permissionSchema.optional(),
        vmId: z.string().uuid().optional(),
        protocol: z.enum(["ssh", "rdp", "vnc"]).optional(),
      })
      .parse(request.query);
    if (!query.permission && !query.vmId) {
      throw AppError.validation("permission or vmId is required");
    }
    const check = await checkAccess(ctx.db, user, query);
    return check;
  });

  // -- Roles ----------------------------------------------------------------
  app.get("/roles", async (request) => {
    await rolesGuard(request);
    return { roles: await listRoles(ctx.db) };
  });

  app.post("/roles", async (request) => {
    const actor = await rolesGuard(request);
    const body = z
      .object({ name: roleNameSchema, description: z.string().max(256).default(""), permissions: z.array(permissionSchema).max(100).default([]) })
      .parse(request.body);
    const catalog = new Set((await listPermissions(ctx.db)).map((p) => p.code));
    const unknown = body.permissions.filter((p) => !catalog.has(p));
    if (unknown.length) throw AppError.validation(`Unknown permissions: ${unknown.join(", ")}`);
    if (await findRoleByName(ctx.db, body.name)) {
      throw AppError.conflict(`Role "${body.name}" already exists`);
    }
    await assertMayConfer(ctx.db, actor, body.permissions);
    const role = await createRole(ctx.db, body);
    await ctx.audit.record({
      event: "ROLE_CREATED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { roleId: role.id, name: role.name, permissions: body.permissions },
    });
    return { role: await getRole(ctx.db, role.id) };
  });

  app.get("/roles/:id", async (request, reply) => {
    await rolesGuard(request);
    const { id } = request.params as { id: string };
    const role = await getRole(ctx.db, id);
    if (!role) return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
    return { role };
  });

  app.patch("/roles/:id", async (request, reply) => {
    const actor = await rolesGuard(request);
    const { id } = request.params as { id: string };
    const role = await getRole(ctx.db, id);
    if (!role) return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
    requireSystemRoleProtection(role, "modification");
    const body = z
      .object({
        name: roleNameSchema.optional(),
        description: z.string().max(256).optional(),
        permissions: z.array(permissionSchema).max(100).optional(),
      })
      .parse(request.body);
    if (body.permissions !== undefined) {
      const catalog = new Set((await listPermissions(ctx.db)).map((p) => p.code));
      const unknown = body.permissions.filter((p) => !catalog.has(p));
      if (unknown.length) throw AppError.validation(`Unknown permissions: ${unknown.join(", ")}`);
    }
    if (body.name !== undefined && body.name !== role.name && (await findRoleByName(ctx.db, body.name))) {
      throw AppError.conflict(`Role "${body.name}" already exists`);
    }
    const before = { name: role.name, description: role.description, permissions: role.permissions };
    if (body.permissions !== undefined) await assertMayConfer(ctx.db, actor, body.permissions);
    await updateRole(ctx.db, id, { name: body.name, description: body.description });
    if (body.permissions !== undefined) await setRolePermissions(ctx.db, id, body.permissions);
    await ctx.audit.record({
      event: "ROLE_UPDATED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { roleId: id, before, after: { name: body.name ?? role.name, permissions: body.permissions ?? role.permissions } },
    });
    return { role: await getRole(ctx.db, id) };
  });

  app.delete("/roles/:id", async (request, reply) => {
    const actor = await rolesGuard(request);
    const { id } = request.params as { id: string };
    const role = await getRole(ctx.db, id);
    if (!role) return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
    requireSystemRoleProtection(role, "deletion");
    await deleteRole(ctx.db, id);
    await ctx.audit.record({
      event: "ROLE_DELETED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { roleId: id, name: role.name, hadUsers: role.userCount, hadGroups: role.groupCount },
    });
    return { ok: true };
  });

  // -- User roles & direct permission grants --------------------------------
  app.post("/users/:id/roles", async (request, reply) => {
    const actor = await usersGuard(request);
    const { id } = request.params as { id: string };
    const target = await ctx.users.findById(id);
    if (!target) return reply.status(404).send({ code: "NOT_FOUND", message: "User not found" });
    const body = z.object({ roleId: z.string().uuid(), expiresAt: expiresAtSchema }).parse(request.body);
    const role = await getRole(ctx.db, body.roleId);
    if (!role) return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
    await assertCanAdministerTarget(ctx.db, actor, id);
    await assertMayConfer(ctx.db, actor, await roleEffectivePermissions(ctx.db, role.id));
    const expiresAt = parseExpiresAt(body.expiresAt);
    await ctx.db.query(
      `INSERT INTO user_roles (user_id, role_id, expires_at, granted_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, role_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, granted_by = EXCLUDED.granted_by`,
      [id, role.id, expiresAt, actor.id],
    );
    await ctx.audit.record({
      event: "ROLE_ASSIGNED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { targetUserId: id, username: target.username, roleId: role.id, roleName: role.name, expiresAt: expiresAt?.toISOString() ?? null },
    });
    if (expiresAt) {
      await ctx.audit.record({
        event: "TEMPORARY_ACCESS_GRANTED",
        actorUserId: actor.id,
        actorUsername: actor.username,
        detail: { kind: "role", targetUserId: id, roleName: role.name, expiresAt: expiresAt.toISOString() },
      });
    }
    return { ok: true };
  });

  app.delete("/users/:id/roles/:roleId", async (request, reply) => {
    const actor = await usersGuard(request);
    const { id, roleId } = request.params as { id: string; roleId: string };
    const target = await ctx.users.findById(id);
    if (!target) return reply.status(404).send({ code: "NOT_FOUND", message: "User not found" });
    const role = await getRole(ctx.db, roleId);
    if (!role) return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
    await assertCanAdministerTarget(ctx.db, actor, id);
    if (role.name === "ADMIN") {
      if (await ctx.users.isInitialAdmin(id)) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: "The initial administrator cannot lose the ADMIN role" });
      }
      if (id === actor.id && (await ctx.users.countActiveAdmins(id)) === 0) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: "You cannot remove your own ADMIN role: no other active administrator exists" });
      }
    }
    await ctx.db.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2", [id, roleId]);
    await ctx.audit.record({
      event: "ROLE_REMOVED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { targetUserId: id, username: target.username, roleId, roleName: role.name },
    });
    return { ok: true };
  });

  app.get("/users/:id/permissions", async (request, reply) => {
    await usersGuard(request);
    const { id } = request.params as { id: string };
    const target = await ctx.users.findById(id);
    if (!target) return reply.status(404).send({ code: "NOT_FOUND", message: "User not found" });
    const effective = await resolveEffectiveAccess(ctx.db, id);
    const directRoles = await ctx.db.query<{ role_id: string; role_name: string; expires_at: Date | null }>(
      `SELECT ur.role_id, r.name AS role_name, ur.expires_at
        FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1
          AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
        ORDER BY r.name ASC`,
      [id],
    );
    return {
      user: { id: target.id, username: target.username, roles: target.roles, active: target.active },
      permissions: [...effective.permissions.entries()].map(([permission, sources]) => ({ permission, sources })),
      vmAccess: [...effective.vmAccess.entries()].map(([vmId, grant]) => ({ vmId, ...grant })),
      roles: effective.roles,
      roleAssignments: directRoles.rows.map((r) => ({ roleId: r.role_id, roleName: r.role_name, expiresAt: r.expires_at })),
      groups: effective.groups,
    };
  });

  app.post("/users/:id/permissions", async (request, reply) => {
    const actor = await usersGuard(request);
    const { id } = request.params as { id: string };
    const target = await ctx.users.findById(id);
    if (!target) return reply.status(404).send({ code: "NOT_FOUND", message: "User not found" });
    const body = z
      .object({ permission: permissionSchema, expiresAt: expiresAtSchema })
      .parse(request.body);
    const catalog = new Set((await listPermissions(ctx.db)).map((p) => p.code));
    if (!catalog.has(body.permission)) {
      throw AppError.validation(`Unknown permission: ${body.permission}`);
    }
    // Conferral rule: no granting permissions the actor does not possess,
    // and no operating on users who hold permissions the actor lacks.
    await assertCanAdministerTarget(ctx.db, actor, id);
    await assertMayConfer(ctx.db, actor, [body.permission]);
    const expiresAt = parseExpiresAt(body.expiresAt);
    await ctx.db.query(
      `INSERT INTO user_permissions (user_id, permission, expires_at, granted_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, permission) DO UPDATE SET expires_at = EXCLUDED.expires_at, granted_by = EXCLUDED.granted_by`,
      [id, body.permission, expiresAt, actor.id],
    );
    await ctx.audit.record({
      event: "USER_PERMISSION_GRANTED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { targetUserId: id, username: target.username, permission: body.permission, expiresAt: expiresAt?.toISOString() ?? null },
    });
    if (expiresAt) {
      await ctx.audit.record({
        event: "TEMPORARY_ACCESS_GRANTED",
        actorUserId: actor.id,
        actorUsername: actor.username,
        detail: { kind: "permission", targetUserId: id, permission: body.permission, expiresAt: expiresAt.toISOString() },
      });
    }
    return { ok: true };
  });

  app.delete("/users/:id/permissions/:permission", async (request, reply) => {
    const actor = await usersGuard(request);
    const { id, permission } = request.params as { id: string; permission: string };
    const target = await ctx.users.findById(id);
    if (!target) return reply.status(404).send({ code: "NOT_FOUND", message: "User not found" });
    await assertCanAdministerTarget(ctx.db, actor, id);
    await ctx.db.query("DELETE FROM user_permissions WHERE user_id = $1 AND permission = $2", [id, permission]);
    await ctx.audit.record({
      event: "USER_PERMISSION_REVOKED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { targetUserId: id, username: target.username, permission },
    });
    return { ok: true };
  });

  // -- Groups ---------------------------------------------------------------
  app.get("/groups", async (request) => {
    await groupsGuard(request);
    return { groups: await listGroups(ctx.db) };
  });

  app.post("/groups", async (request, reply) => {
    const actor = await groupsGuard(request);
    const body = z
      .object({ name: groupNameSchema, description: z.string().max(256).default("") })
      .parse(request.body);
    if (await findGroupByName(ctx.db, body.name)) {
      return reply.status(409).send({ code: "CONFLICT", message: `Group "${body.name}" already exists` });
    }
    const group = await createGroup(ctx.db, { ...body, createdBy: actor.id });
    await ctx.audit.record({
      event: "GROUP_CREATED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { groupId: group.id, name: group.name },
    });
    return { group: await getGroup(ctx.db, group.id) };
  });

  app.get("/groups/:id", async (request, reply) => {
    await groupsGuard(request);
    const { id } = request.params as { id: string };
    const group = await getGroup(ctx.db, id);
    if (!group) return reply.status(404).send({ code: "NOT_FOUND", message: "Group not found" });
    return {
      group,
      members: await groupMembers(ctx.db, id),
      roles: await groupRoles(ctx.db, id),
      vms: await groupVms(ctx.db, id),
    };
  });

  app.patch("/groups/:id", async (request, reply) => {
    const actor = await groupsGuard(request);
    const { id } = request.params as { id: string };
    const group = await getGroup(ctx.db, id);
    if (!group) return reply.status(404).send({ code: "NOT_FOUND", message: "Group not found" });
    const body = z
      .object({ name: groupNameSchema.optional(), description: z.string().max(256).optional() })
      .parse(request.body);
    if (body.name && body.name !== group.name && (await findGroupByName(ctx.db, body.name))) {
      return reply.status(409).send({ code: "CONFLICT", message: `Group "${body.name}" already exists` });
    }
    await ctx.db.query(
      "UPDATE groups SET name = COALESCE($2, name), description = COALESCE($3, description) WHERE id = $1",
      [id, body.name ?? null, body.description ?? null],
    );
    await ctx.audit.record({
      event: "GROUP_UPDATED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { groupId: id, before: { name: group.name }, after: { name: body.name ?? group.name } },
    });
    return { group: await getGroup(ctx.db, id) };
  });

  app.delete("/groups/:id", async (request, reply) => {
    const actor = await groupsGuard(request);
    const { id } = request.params as { id: string };
    const group = await getGroup(ctx.db, id);
    if (!group) return reply.status(404).send({ code: "NOT_FOUND", message: "Group not found" });
    const members = await groupMemberIds(id);
    const vmIds = await groupVmIds(id);
    await ctx.db.query("DELETE FROM groups WHERE id = $1", [id]);
    for (const userId of members) {
      for (const vmId of vmIds) await reconcileVm(userId, vmId);
    }
    await ctx.audit.record({
      event: "GROUP_DELETED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { groupId: id, name: group.name, hadMembers: members.length, hadVms: vmIds.length },
    });
    return { ok: true };
  });

  app.post("/groups/:id/members", async (request, reply) => {
    const actor = await groupsGuard(request);
    const { id } = request.params as { id: string };
    const group = await getGroup(ctx.db, id);
    if (!group) return reply.status(404).send({ code: "NOT_FOUND", message: "Group not found" });
    const body = z
      .object({ userId: z.string().uuid().optional(), username: z.string().min(1).max(128).optional(), expiresAt: expiresAtSchema })
      .refine((b) => b.userId !== undefined || b.username !== undefined, {
        message: "Either userId or username is required",
      })
      .parse(request.body);
    const target = body.userId
      ? await ctx.users.findById(body.userId)
      : await ctx.users.findByUsername(body.username as string);
    if (!target) return reply.status(404).send({ code: "NOT_FOUND", message: "User not found" });
    const expiresAt = parseExpiresAt(body.expiresAt);
    await ctx.db.query(
      `INSERT INTO group_members (group_id, user_id, expires_at, added_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (group_id, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, added_by = EXCLUDED.added_by`,
      [id, target.id, expiresAt, actor.id],
    );
    for (const vmId of await groupVmIds(id)) await reconcileVm(target.id, vmId);
    await ctx.audit.record({
      event: "GROUP_MEMBER_ADDED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { groupId: id, groupName: group.name, targetUserId: target.id, username: target.username, expiresAt: expiresAt?.toISOString() ?? null },
    });
    if (expiresAt) {
      await ctx.audit.record({
        event: "TEMPORARY_ACCESS_GRANTED",
        actorUserId: actor.id,
        actorUsername: actor.username,
        detail: { kind: "group-membership", groupId: id, targetUserId: target.id, expiresAt: expiresAt.toISOString() },
      });
    }
    return { ok: true };
  });

  app.delete("/groups/:id/members/:userId", async (request, reply) => {
    const actor = await groupsGuard(request);
    const { id, userId } = request.params as { id: string; userId: string };
    const group = await getGroup(ctx.db, id);
    if (!group) return reply.status(404).send({ code: "NOT_FOUND", message: "Group not found" });
    const target = await ctx.users.findById(userId);
    await assertCanAdministerTarget(ctx.db, actor, userId);
    await ctx.db.query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [id, userId]);
    for (const vmId of await groupVmIds(id)) await reconcileVm(userId, vmId);
    await ctx.audit.record({
      event: "GROUP_MEMBER_REMOVED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { groupId: id, groupName: group.name, targetUserId: userId, username: target?.username ?? null },
    });
    return { ok: true };
  });

  app.post("/groups/:id/roles", async (request, reply) => {
    const actor = await groupsGuard(request);
    const { id } = request.params as { id: string };
    const group = await getGroup(ctx.db, id);
    if (!group) return reply.status(404).send({ code: "NOT_FOUND", message: "Group not found" });
    const body = z.object({ roleId: z.string().uuid(), expiresAt: expiresAtSchema }).parse(request.body);
    const role = await getRole(ctx.db, body.roleId);
    if (!role) return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
    // Conferring a role to a group confers it to every member: the actor
    // must hold everything the role carries.
    await assertMayConfer(ctx.db, actor, await roleEffectivePermissions(ctx.db, role.id));
    const expiresAt = parseExpiresAt(body.expiresAt);
    await ctx.db.query(
      `INSERT INTO group_roles (group_id, role_id, expires_at, granted_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (group_id, role_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, granted_by = EXCLUDED.granted_by`,
      [id, role.id, expiresAt, actor.id],
    );
    for (const userId of await groupMemberIds(id)) {
      for (const vmId of await groupVmIds(id)) await reconcileVm(userId, vmId);
    }
    await ctx.audit.record({
      event: "GROUP_ROLE_ASSIGNED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { groupId: id, groupName: group.name, roleId: role.id, roleName: role.name, expiresAt: expiresAt?.toISOString() ?? null },
    });
    return { ok: true };
  });

  app.delete("/groups/:id/roles/:roleId", async (request, reply) => {
    const actor = await groupsGuard(request);
    const { id, roleId } = request.params as { id: string; roleId: string };
    const group = await getGroup(ctx.db, id);
    if (!group) return reply.status(404).send({ code: "NOT_FOUND", message: "Group not found" });
    const role = await getRole(ctx.db, roleId);
    await ctx.db.query("DELETE FROM group_roles WHERE group_id = $1 AND role_id = $2", [id, roleId]);
    for (const userId of await groupMemberIds(id)) {
      for (const vmId of await groupVmIds(id)) await reconcileVm(userId, vmId);
    }
    await ctx.audit.record({
      event: "GROUP_ROLE_REMOVED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { groupId: id, groupName: group.name, roleId, roleName: role?.name ?? null },
    });
    return { ok: true };
  });

  app.post("/groups/:id/vms", async (request, reply) => {
    const actor = await groupsGuard(request);
    const { id } = request.params as { id: string };
    const group = await getGroup(ctx.db, id);
    if (!group) return reply.status(404).send({ code: "NOT_FOUND", message: "Group not found" });
    const body = z
      .object({ vmId: z.string().uuid(), protocols: protocolsSchema, expiresAt: expiresAtSchema })
      .parse(request.body);
    const vm = await ctx.vms.requireById(body.vmId);
    const protocols = body.protocols !== undefined ? [...new Set(body.protocols)] : null;
    const expiresAt = parseExpiresAt(body.expiresAt);
    await ctx.db.query(
      `INSERT INTO group_vm_access (group_id, vm_id, protocols, expires_at, created_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (group_id, vm_id) DO UPDATE SET
          protocols = EXCLUDED.protocols, expires_at = EXCLUDED.expires_at, created_by = EXCLUDED.created_by`,
      [id, vm.id, protocols, expiresAt, actor.id],
    );
    for (const userId of await groupMemberIds(id)) await reconcileVm(userId, vm.id);
    await ctx.audit.record({
      event: "VM_ACCESS_GRANTED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      vmId: vm.id,
      detail: { groupId: id, groupName: group.name, protocols, expiresAt: expiresAt?.toISOString() ?? null, guacSynced: true },
    });
    if (expiresAt) {
      await ctx.audit.record({
        event: "TEMPORARY_ACCESS_GRANTED",
        actorUserId: actor.id,
        actorUsername: actor.username,
        vmId: vm.id,
        detail: { kind: "group-vm-access", groupId: id, expiresAt: expiresAt.toISOString(), protocols },
      });
    }
    return { ok: true };
  });

  app.delete("/groups/:id/vms/:vmId", async (request, reply) => {
    const actor = await groupsGuard(request);
    const { id, vmId } = request.params as { id: string; vmId: string };
    const group = await getGroup(ctx.db, id);
    if (!group) return reply.status(404).send({ code: "NOT_FOUND", message: "Group not found" });
    await ctx.db.query("DELETE FROM group_vm_access WHERE group_id = $1 AND vm_id = $2", [id, vmId]);
    for (const userId of await groupMemberIds(id)) await reconcileVm(userId, vmId);
    await ctx.audit.record({
      event: "VM_ACCESS_REVOKED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      vmId,
      detail: { groupId: id, groupName: group.name, guacSynced: true },
    });
    return { ok: true };
  });

  // -- Matrix ---------------------------------------------------------------
  app.get("/iam/matrix", async (request) => {
    await usersGuard(request);
    const users = await ctx.users.list();
    const catalog = await listPermissions(ctx.db);
    const rows = [];
    for (const user of users) {
      const effective = await resolveEffectiveAccess(ctx.db, user.id);
      rows.push({
        user: { id: user.id, username: user.username, roles: user.roles, active: user.active },
        permissions: [...effective.permissions.entries()].map(([permission, sources]) => ({ permission, sources })),
        vmAccess: [...effective.vmAccess.entries()].map(([vmId, grant]) => ({ vmId, ...grant })),
        groups: effective.groups,
      });
    }
    return { permissions: catalog, users: rows };
  });
}
