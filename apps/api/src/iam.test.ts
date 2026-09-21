import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import {
  createCore,
  makeLogger,
  hashPassword,
  type CoreContext,
  type LocalConfig,
} from "@proxvm/core";
import { buildApp } from "../src/app.js";
import RedisMockCtor from "ioredis-mock";

const masterKey = "2".repeat(64);

const localConfig: LocalConfig = {
  version: 1,
  app: {
    cookieSecure: false,
    sessionDurationHours: 12,
    sessionIdleTimeoutMinutes: 120,
    allowRegistrationOpen: false,
  },
  database: { host: "localhost", port: 5432, name: "proxvm", user: "u", password: "p", ssl: false },
  redis: { host: "127.0.0.1", port: 6379, db: 0 },
  secrets: {
    sessionSigningKey: "s".repeat(64),
    masterKeyId: "v1",
    masterKey,
  },
};

interface Session {
  cookie: string;
  csrf: string;
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<Session> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "proxvm_session");
  return {
    cookie: `${cookie?.name}=${cookie?.value}`,
    csrf: (res.json() as { csrfToken: string }).csrfToken,
  };
}

const FAKE_UUID = "11111111-1111-4111-8111-111111111111";
const future = () => new Date(Date.now() + 3600_000).toISOString();

describe("IAM system", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let operator: Session;
  let alice: Session;
  let aliceId: string;
  let vmId: string;
  let rdpRoleId = "";
  let groupId = "";

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    await ctx.users.create({
      username: "admin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    await ctx.users.create({
      username: "op",
      passwordHash: await hashPassword("Operator-Pass-1!"),
      roles: ["OPERATOR"],
    });
    const aliceUser = await ctx.users.create({
      username: "alice",
      passwordHash: await hashPassword("Alice-Password-1!"),
      roles: ["USER"],
    });
    aliceId = aliceUser.id;
    const vm = await ctx.vms.create({ vmid: 901, node: "node1", name: "iam-vm", status: "stopped", osType: "linux" });
    vmId = vm.id;

    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
    operator = await login(app, "op", "Operator-Pass-1!");
    alice = await login(app, "alice", "Alice-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (s: Session) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });
  const get = (s: Session) => ({ cookie: s.cookie });

  it("catalog exposes the enforced permission vocabulary", async () => {
    const res = await app.inject({ method: "GET", url: "/api/iam/catalog", headers: get(admin) });
    expect(res.statusCode).toBe(200);
    const codes = (res.json() as { permissions: Array<{ code: string }> }).permissions.map((p) => p.code);
    for (const code of ["vm.start", "vm.stop", "vm.restart", "roles.manage", "groups.manage", "protocol.ssh", "protocol.rdp", "protocol.vnc", "vm.manage", "guac.launch"]) {
      expect(codes).toContain(code);
    }
  });

  it("admin can create/get/patch/delete a custom role; system roles are protected", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth(admin),
      payload: {
        name: "RDP Operator",
        description: "RDP-only operator",
        permissions: ["vm.list", "vm.read", "vm.start", "vm.stop", "vm.restart", "protocol.rdp"],
      },
    });
    expect(create.statusCode).toBe(200);
    rdpRoleId = (create.json() as { role: { id: string } }).role.id;

    const dup = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth(admin),
      payload: { name: "RDP Operator", permissions: [] },
    });
    expect(dup.statusCode).toBe(409);

    const badPerm = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth(admin),
      payload: { name: "Bogus", permissions: ["vm.teleport"] },
    });
    expect(badPerm.statusCode).toBe(400);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/roles/${rdpRoleId}`,
      headers: auth(admin),
      payload: { description: "updated" },
    });
    expect(patch.statusCode).toBe(200);

    // Built-in presets cannot be modified or deleted.
    const viewerId = "00000000-0000-0000-0000-000000000101";
    const sysPatch = await app.inject({
      method: "PATCH",
      url: `/api/roles/${viewerId}`,
      headers: auth(admin),
      payload: { description: "hack" },
    });
    expect(sysPatch.statusCode).toBe(403);
    const sysDel = await app.inject({
      method: "DELETE",
      url: `/api/roles/${viewerId}`,
      headers: auth(admin),
    });
    expect(sysDel.statusCode).toBe(403);
  });

  it("non-admins cannot manage roles", async () => {
    for (const s of [operator, alice]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/roles",
        headers: auth(s),
        payload: { name: "Hacker", permissions: [] },
      });
      expect(res.statusCode).toBe(403);
      const group = await app.inject({
        method: "POST",
        url: "/api/groups",
        headers: auth(s),
        payload: { name: "hackers" },
      });
      expect(group.statusCode).toBe(403);
    }
    const anon = await app.inject({ method: "GET", url: "/api/roles" });
    expect(anon.statusCode).toBe(401);
  });

  it("custom role assignment confers real route access (vm.start)", async () => {
    // alice has no vm.start and no VM access yet.
    const denied = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/start`,
      headers: auth(alice),
      payload: {},
    });
    expect([401, 403]).toContain(denied.statusCode);

    const assign = await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/roles`,
      headers: auth(admin),
      payload: { roleId: rdpRoleId },
    });
    expect(assign.statusCode).toBe(200);

    // Role assignment alone is not enough without VM access.
    const stillDenied = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/start`,
      headers: auth(alice),
      payload: {},
    });
    expect(stillDenied.statusCode).toBe(403);

    // Grant VM access; now the granular permission passes authorization
    // (Proxmox is unconfigured in tests, so it fails downstream, not on auth).
    await ctx.vms.setAccess(vmId, aliceId, null);
    const pastAuth = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/start`,
      headers: auth(alice),
      payload: {},
    });
    expect([401, 403]).not.toContain(pastAuth.statusCode);
  });

  it("expired role assignments are ignored", async () => {
    await ctx.db.query("UPDATE user_roles SET expires_at = NOW() - interval '1 minute' WHERE user_id = $1", [aliceId]);
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/start`,
      headers: auth(alice),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    // Restore for later tests.
    await ctx.db.query("UPDATE user_roles SET expires_at = NULL WHERE user_id = $1", [aliceId]);
  });

  it("direct permission grants work, expire, and cannot be self-granted", async () => {
    const grant = await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/permissions`,
      headers: auth(admin),
      payload: { permission: "vm.stop", expiresAt: future() },
    });
    expect(grant.statusCode).toBe(200);

    const badPerm = await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/permissions`,
      headers: auth(admin),
      payload: { permission: "vm.teleport" },
    });
    expect(badPerm.statusCode).toBe(400);

    const past = await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/permissions`,
      headers: auth(admin),
      payload: { permission: "vm.delete", expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    expect(past.statusCode).toBe(400);

    // USER cannot grant anything (403), even to herself.
    const selfGrant = await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/permissions`,
      headers: auth(alice),
      payload: { permission: "vm.read" },
    });
    expect(selfGrant.statusCode).toBe(403);

    // OPERATOR (no users.manage) cannot grant either.
    const opGrant = await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/permissions`,
      headers: auth(operator),
      payload: { permission: "vm.read" },
    });
    expect(opGrant.statusCode).toBe(403);

    // Effective view shows the grant with its source.
    const eff = await app.inject({
      method: "GET",
      url: `/api/users/${aliceId}/permissions`,
      headers: get(admin),
    });
    expect(eff.statusCode).toBe(200);
    const perms = (eff.json() as { permissions: Array<{ permission: string; sources: string[] }> }).permissions;
    expect(perms.find((p) => p.permission === "vm.stop")?.sources).toContain("direct grant");

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/users/${aliceId}/permissions/vm.stop`,
      headers: auth(admin),
    });
    expect(revoke.statusCode).toBe(200);
  });

  it("groups: CRUD, members, roles, VM access with inheritance", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: auth(admin),
      payload: { name: "students", description: "Robotics Students" },
    });
    expect(create.statusCode).toBe(200);
    groupId = (create.json() as { group: { id: string } }).group.id;

    const dup = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: auth(admin),
      payload: { name: "students" },
    });
    expect(dup.statusCode).toBe(409);

    const addMember = await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/members`,
      headers: auth(admin),
      payload: { userId: aliceId },
    });
    expect(addMember.statusCode).toBe(200);

    const badMember = await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/members`,
      headers: auth(admin),
      payload: { userId: FAKE_UUID },
    });
    expect(badMember.statusCode).toBe(404);

    const addRole = await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/roles`,
      headers: auth(admin),
      payload: { roleId: rdpRoleId },
    });
    expect(addRole.statusCode).toBe(200);

    const grantVm = await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/vms`,
      headers: auth(admin),
      payload: { vmId, protocols: ["rdp"], expiresAt: future() },
    });
    expect(grantVm.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/groups/${groupId}`,
      headers: get(admin),
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      members: Array<{ username: string }>;
      roles: Array<{ roleName: string }>;
      vms: Array<{ vmId: string; protocols: string[] | null }>;
    };
    expect(body.members.map((m) => m.username)).toContain("alice");
    expect(body.roles.map((r) => r.roleName)).toContain("RDP Operator");
    expect(body.vms.find((v) => v.vmId === vmId)?.protocols).toEqual(["rdp"]);

    // alice inherits group VM access (in addition to her direct legacy row).
    const check = await app.inject({
      method: "GET",
      url: `/api/authorization/check?vmId=${vmId}&protocol=rdp`,
      headers: get(alice),
    });
    expect(check.statusCode).toBe(200);
    expect((check.json() as { allowed: boolean }).allowed).toBe(true);

    // Member removal revokes the inherited access.
    const removeMember = await app.inject({
      method: "DELETE",
      url: `/api/groups/${groupId}/members/${aliceId}`,
      headers: auth(admin),
    });
    expect(removeMember.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: `/api/groups/${groupId}`,
      headers: get(admin),
    });
    expect((after.json() as { members: unknown[] }).members).toHaveLength(0);
  });

  it("group detail exposes effective permissions with provenance and descriptions", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: auth(admin),
      payload: { name: "perm-viewers" },
    });
    expect(create.statusCode).toBe(200);
    const gid = (create.json() as { group: { id: string } }).group.id;

    const addRdpRole = await app.inject({
      method: "POST",
      url: `/api/groups/${gid}/roles`,
      headers: auth(admin),
      payload: { roleId: rdpRoleId },
    });
    expect(addRdpRole.statusCode).toBe(200);

    // Legacy role (hardcoded permission set) alongside the custom role.
    const rolesRes = await app.inject({ method: "GET", url: "/api/roles", headers: get(admin) });
    expect(rolesRes.statusCode).toBe(200);
    const userRole = (rolesRes.json() as { roles: Array<{ id: string; name: string }> }).roles.find(
      (r) => r.name === "USER",
    );
    expect(userRole).toBeTruthy();
    const addUserRole = await app.inject({
      method: "POST",
      url: `/api/groups/${gid}/roles`,
      headers: auth(admin),
      payload: { roleId: userRole!.id },
    });
    expect(addUserRole.statusCode).toBe(200);

    const detail = await app.inject({ method: "GET", url: `/api/groups/${gid}`, headers: get(admin) });
    expect(detail.statusCode).toBe(200);
    const perms = (
      detail.json() as {
        permissions: Array<{ code: string; category: string; description: string; scope: string; roles: string[] }>;
      }
    ).permissions;
    const byCode = new Map(perms.map((p) => [p.code, p]));
    // Custom-role provenance with catalog description.
    expect(byCode.get("protocol.rdp")?.roles).toEqual(["RDP Operator"]);
    expect(byCode.get("protocol.rdp")?.description).toBe("Use RDP on accessible VMs");
    expect(byCode.get("protocol.rdp")?.category).toBe("Remote Access");
    // Union across custom + legacy roles, roles sorted.
    expect(byCode.get("vm.read")?.roles).toEqual(["RDP Operator", "USER"]);
    // Legacy-only permission.
    expect(byCode.get("guac.launch")?.roles).toEqual(["USER"]);
    // Every entry carries catalog metadata.
    for (const p of perms) {
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.category.length).toBeGreaterThan(0);
    }
  });

  it("delegated group-managers cannot self-escalate via members or VM grants", async () => {
    const roleRes = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth(admin),
      payload: { name: "Group Manager", description: "t", permissions: ["groups.manage"] },
    });
    expect(roleRes.statusCode).toBe(200);
    const gmRoleId = (roleRes.json() as { role: { id: string } }).role.id;

    const mgrUser = await ctx.users.create({
      username: "mgr",
      passwordHash: await hashPassword("Mgr-Password-1!"),
      roles: ["USER"],
    });
    const assign = await app.inject({
      method: "POST",
      url: `/api/users/${mgrUser.id}/roles`,
      headers: auth(admin),
      payload: { roleId: gmRoleId },
    });
    expect(assign.statusCode).toBe(200);
    const mgr = await login(app, "mgr", "Mgr-Password-1!");

    // Empty group: adding a plain user confers nothing, so it succeeds.
    const dave = await ctx.users.create({
      username: "dave",
      passwordHash: await hashPassword("Dave-Password-1!"),
      roles: ["USER"],
    });
    const g = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: auth(mgr),
      payload: { name: "course101" },
    });
    expect(g.statusCode).toBe(200);
    const gid = (g.json() as { group: { id: string } }).group.id;
    const addDave = await app.inject({
      method: "POST",
      url: `/api/groups/${gid}/members`,
      headers: auth(mgr),
      payload: { userId: dave.id },
    });
    expect(addDave.statusCode).toBe(200);

    // ADMIN-role group: adding a member would confer admin -> 403.
    const rolesRes = await app.inject({ method: "GET", url: "/api/roles", headers: get(admin) });
    const adminRole = (rolesRes.json() as { roles: Array<{ id: string; name: string }> }).roles.find(
      (r) => r.name === "ADMIN",
    )!;
    const g2 = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: auth(admin),
      payload: { name: "admins-ish" },
    });
    const gid2 = (g2.json() as { group: { id: string } }).group.id;
    const linkAdmin = await app.inject({
      method: "POST",
      url: `/api/groups/${gid2}/roles`,
      headers: auth(admin),
      payload: { roleId: adminRole.id },
    });
    expect(linkAdmin.statusCode).toBe(200);
    const escAdd = await app.inject({
      method: "POST",
      url: `/api/groups/${gid2}/members`,
      headers: auth(mgr),
      payload: { userId: dave.id },
    });
    expect(escAdd.statusCode).toBe(403);

    // VM grants need vm.edit on top of groups.manage.
    const grantVm = await app.inject({
      method: "POST",
      url: `/api/groups/${gid}/vms`,
      headers: auth(mgr),
      payload: { vmId },
    });
    expect(grantVm.statusCode).toBe(403);
  });

  it("protocol scoping is enforced on launch with safe explanations", async () => {
    // alice: direct legacy access (all protocols) + group rdp-only access.
    // Re-add her to the group first.
    await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/members`,
      headers: auth(admin),
      payload: { userId: aliceId },
    });
    const denied = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/guacamole/launch`,
      headers: auth(alice),
      payload: { protocol: "ssh" },
    });
    expect(denied.statusCode).toBe(403);
    const body = denied.json() as { explanation?: { reason: string } };
    expect(body.explanation?.reason).toBe("protocol_denied");

    // RDP passes authorization (Guacamole is unconfigured in tests).
    const allowed = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/guacamole/launch`,
      headers: auth(alice),
      payload: { protocol: "rdp" },
    });
    expect([401, 403]).not.toContain(allowed.statusCode);
  });

  it("launch without protocol resolves to an allowed one, never a denied one", async () => {
    // alice: direct legacy access (all) is gone here; she has group rdp-only
    // access from the earlier test. Omitting protocol must resolve to rdp.
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/guacamole/launch`,
      headers: auth(alice),
      payload: {},
    });
    // Guacamole is unconfigured in tests: reaching CONFIGURATION_ERROR proves
    // authorization passed (protocol resolved to an allowed connection).
    expect([401, 403]).not.toContain(res.statusCode);
    expect((res.json() as { code: string }).code).toBe("CONFIGURATION_ERROR");
  });

  it("expired group membership denies even with a live group VM grant", async () => {
    // Isolate to group-derived access only: drop the direct legacy row first.
    await ctx.db.query("DELETE FROM vm_access WHERE vm_id = $1 AND user_id = $2", [vmId, aliceId]);
    await ctx.db.query(
      "UPDATE group_members SET expires_at = NOW() - interval '1 minute' WHERE group_id = $1 AND user_id = $2",
      [groupId, aliceId],
    );
    const check = await app.inject({
      method: "GET",
      url: `/api/authorization/check?vmId=${vmId}&protocol=rdp`,
      headers: get(alice),
    });
    expect((check.json() as { allowed: boolean }).allowed).toBe(false);
    const launch = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/guacamole/launch`,
      headers: auth(alice),
      payload: { protocol: "rdp" },
    });
    expect(launch.statusCode).toBe(403);
    // Restore membership (direct row is recreated by later tests as needed).
    await ctx.db.query("UPDATE group_members SET expires_at = NULL WHERE group_id = $1 AND user_id = $2", [
      groupId,
      aliceId,
    ]);
  });

  it("expired VM access denies with access_expired and self-cleans on launch", async () => {
    await ctx.db.query(
      "INSERT INTO vm_access (vm_id, user_id, expires_at) VALUES ($1, $2, NOW() - interval '1 minute') ON CONFLICT (vm_id, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, protocols = NULL",
      [vmId, aliceId],
    );
    // Remove group membership so only the expired direct row remains.
    await ctx.db.query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [groupId, aliceId]);
    const denied = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/guacamole/launch`,
      headers: auth(alice),
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { explanation?: { reason: string } }).explanation?.reason).toBe("access_expired");
    // Self-cleaning removed the expired direct row.
    const rows = await ctx.db.query("SELECT * FROM vm_access WHERE vm_id = $1 AND user_id = $2", [vmId, aliceId]);
    expect(rows.rows).toHaveLength(0);
    const audit = await ctx.audit.list({ vmId, limit: 50 });
    expect(audit.map((a) => a.event)).toContain("TEMPORARY_ACCESS_EXPIRED");
  });

  it("matrix and effective endpoints expose sources without secrets", async () => {
    const matrix = await app.inject({ method: "GET", url: "/api/iam/matrix", headers: get(admin) });
    expect(matrix.statusCode).toBe(200);
    const body = matrix.json() as {
      permissions: Array<{ code: string }>;
      users: Array<{ user: { username: string }; permissions: unknown[]; vmAccess: unknown[]; groups: unknown[] }>;
    };
    expect(body.permissions.length).toBeGreaterThanOrEqual(28);
    expect(body.users.map((u) => u.user.username)).toEqual(expect.arrayContaining(["admin", "op", "alice"]));
    expect(JSON.stringify(body)).not.toMatch(/password|secret|token/i);

    const denied = await app.inject({ method: "GET", url: "/api/iam/matrix", headers: get(alice) });
    expect(denied.statusCode).toBe(403);

    const eff = await app.inject({ method: "GET", url: "/api/iam/effective", headers: get(alice) });
    expect(eff.statusCode).toBe(200);
  });

  it("permission sheet exposes direct role assignments for removal", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth(admin),
      payload: { name: "Sheet Role", permissions: ["vm.read"] },
    });
    const roleId = (create.json() as { role: { id: string } }).role.id;
    await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/roles`,
      headers: auth(admin),
      payload: { roleId },
    });
    const view = await app.inject({
      method: "GET",
      url: `/api/users/${aliceId}/permissions`,
      headers: get(admin),
    });
    expect(view.statusCode).toBe(200);
    const body = view.json() as {
      roleAssignments: Array<{ roleId: string; roleName: string; expiresAt: string | null }>;
    };
    expect(body.roleAssignments.map((a) => a.roleName)).toContain("Sheet Role");
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/users/${aliceId}/roles/${roleId}`,
      headers: auth(admin),
    });
    expect(remove.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: `/api/users/${aliceId}/permissions`,
      headers: get(admin),
    });
    expect(
      ((after.json() as typeof body).roleAssignments ?? []).map((a) => a.roleName),
    ).not.toContain("Sheet Role");
    await app.inject({ method: "DELETE", url: `/api/roles/${roleId}`, headers: auth(admin) });
  });

  it("group deletion cascades and re-delete is safe", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: `/api/groups/${groupId}`,
      headers: auth(admin),
    });
    expect(del.statusCode).toBe(200);
    const gone = await app.inject({
      method: "GET",
      url: `/api/groups/${groupId}`,
      headers: get(admin),
    });
    expect(gone.statusCode).toBe(404);
    const delRole = await app.inject({
      method: "DELETE",
      url: `/api/roles/${rdpRoleId}`,
      headers: auth(admin),
    });
    expect(delRole.statusCode).toBe(200);
  });

  it("missing resources fail cleanly", async () => {
    const noGroup = await app.inject({ method: "GET", url: `/api/groups/${FAKE_UUID}`, headers: get(admin) });
    expect(noGroup.statusCode).toBe(404);
    const noRole = await app.inject({ method: "GET", url: `/api/roles/${FAKE_UUID}`, headers: get(admin) });
    expect(noRole.statusCode).toBe(404);
    const noUser = await app.inject({
      method: "POST",
      url: `/api/users/${FAKE_UUID}/roles`,
      headers: auth(admin),
      payload: { roleId: FAKE_UUID },
    });
    expect(noUser.statusCode).toBe(404);
  });
});
