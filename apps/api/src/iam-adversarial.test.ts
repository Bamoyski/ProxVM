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

const masterKey = "1".repeat(64);

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

const ADMIN_ROLE = "00000000-0000-0000-0000-000000000001";
const future = () => new Date(Date.now() + 3600_000).toISOString();

describe("IAM adversarial: privilege escalation resistance", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let mallory: Session;
  let aliceId: string;
  let malloryId: string;
  let adminId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    const adminUser = await ctx.users.create({
      username: "admin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    adminId = adminUser.id;
    const alice = await ctx.users.create({
      username: "alice",
      passwordHash: await hashPassword("Alice-Password-1!"),
      roles: ["USER"],
    });
    aliceId = alice.id;
    const malloryUser = await ctx.users.create({
      username: "mallory",
      passwordHash: await hashPassword("Mallory-Pass-1!"),
      roles: ["USER"],
    });
    malloryId = malloryUser.id;
    // Mallory holds users.manage + roles.manage + groups.manage (plus base
    // USER perms): a lesser-privileged user-administrator — the dangerous
    // middle tier. She can manage IAM objects but possesses no VM, credential
    // or protocol permissions beyond a plain USER.
    for (const perm of ["users.manage", "roles.manage", "groups.manage"]) {
      await ctx.db.query("INSERT INTO user_permissions (user_id, permission) VALUES ($1, $2)", [malloryId, perm]);
    }

    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
    mallory = await login(app, "mallory", "Mallory-Pass-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (s: Session) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

  it("lesser user-admin cannot create ADMIN users", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: auth(mallory),
      payload: { username: "eviladmin", password: "Evil-Password-1!", role: "ADMIN" },
    });
    expect(res.statusCode).toBe(403);
    expect(await ctx.users.findByUsername("eviladmin")).toBeNull();
  });

  it("lesser user-admin cannot promote anyone to ADMIN (legacy or IAM path)", async () => {
    const legacy = await app.inject({
      method: "PUT",
      url: `/api/users/${aliceId}`,
      headers: auth(mallory),
      payload: { role: "ADMIN" },
    });
    expect(legacy.statusCode).toBe(403);

    const iam = await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/roles`,
      headers: auth(mallory),
      payload: { roleId: ADMIN_ROLE },
    });
    expect(iam.statusCode).toBe(403);
    const alice = (await ctx.users.findById(aliceId))!;
    expect(alice.roles).not.toContain("ADMIN");
  });

  it("lesser user-admin cannot touch more-privileged users", async () => {
    // Password reset on the admin = account takeover attempt.
    const reset = await app.inject({
      method: "PUT",
      url: `/api/users/${adminId}`,
      headers: auth(mallory),
      payload: { password: "Stolen-Password-1!" },
    });
    expect(reset.statusCode).toBe(403);

    const disable = await app.inject({
      method: "PUT",
      url: `/api/users/${adminId}`,
      headers: auth(mallory),
      payload: { active: false },
    });
    expect(disable.statusCode).toBe(403);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/users/${adminId}`,
      headers: auth(mallory),
    });
    expect(del.statusCode).toBe(403);

    const strip = await app.inject({
      method: "DELETE",
      url: `/api/users/${adminId}/roles/${ADMIN_ROLE}`,
      headers: auth(mallory),
    });
    expect(strip.statusCode).toBe(403);
  });

  it("lesser user-admin cannot launder permissions through custom roles", async () => {
    // Creating a role carrying unpossessed permissions is blocked.
    const create = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth(mallory),
      payload: { name: "Evil", permissions: ["vm.delete"] },
    });
    expect(create.statusCode).toBe(403);

    // Even a benign role cannot be weaponized: assignment requires
    // possessing everything the role carries. Build an over-privileged
    // role directly in the DB (simulating a confused/deputy scenario).
    await ctx.db.query("INSERT INTO roles (id, name, description, is_system) VALUES ($1, 'sneaky', '', false)", [
      "22222222-2222-4222-8222-222222222222",
    ]);
    await ctx.db.query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'vm.delete')", [
      "22222222-2222-4222-8222-222222222222",
    ]);
    const assign = await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/roles`,
      headers: auth(mallory),
      payload: { roleId: "22222222-2222-4222-8222-222222222222" },
    });
    expect(assign.statusCode).toBe(403);
  });

  it("lesser user-admin CAN administer peers (no over-blocking)", async () => {
    // Benign role holding only possessed permissions.
    const create = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth(mallory),
      payload: { name: "Junior", permissions: ["vm.read"] },
    });
    expect(create.statusCode).toBe(200);
    const roleId = (create.json() as { role: { id: string } }).role.id;

    const assign = await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/roles`,
      headers: auth(mallory),
      payload: { roleId },
    });
    expect(assign.statusCode).toBe(200);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/users/${aliceId}/roles/${roleId}`,
      headers: auth(mallory),
    });
    expect(remove.statusCode).toBe(200);
    await ctx.db.query("DELETE FROM roles WHERE id = $1", [roleId]);
  });

  it("admin retains full conferral power (positive control)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: auth(admin),
      payload: { username: "newadmin", password: "Newadmin-Pass-1!", role: "ADMIN" },
    });
    expect(create.statusCode).toBe(200);
    const assign = await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/roles`,
      headers: auth(admin),
      payload: { roleId: ADMIN_ROLE },
    });
    expect(assign.statusCode).toBe(200);
    // Restore alice for later tests.
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/users/${aliceId}/roles/${ADMIN_ROLE}`,
      headers: auth(admin),
    });
    expect(remove.statusCode).toBe(200);
    const bob = await ctx.users.findByUsername("newadmin");
    await ctx.users.deleteGuarded(bob!.id);
  });

  it("sole admin cannot strip their own ADMIN role via IAM", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${adminId}/roles/${ADMIN_ROLE}`,
      headers: auth(admin),
    });
    expect(res.statusCode).toBe(400);
    const stillAdmin = (await ctx.users.findById(adminId))!;
    expect(stillAdmin.roles).toContain("ADMIN");
  });

  it("malformed IDs on IAM routes never 500", async () => {
    for (const [method, url, payload, expected] of [
      ["GET", "/api/roles/not-a-uuid", undefined, 404],
      ["GET", "/api/groups/not-a-uuid", undefined, 404],
      ["DELETE", "/api/groups/not-a-uuid", {}, 404],
      ["POST", "/api/groups/not-a-uuid/members", { userId: aliceId }, 404],
      // Query-string UUIDs are schema-validated: 400, never 500.
      ["GET", "/api/authorization/check?vmId=not-a-uuid", undefined, 400],
      ["POST", "/api/vms/not-a-uuid/guacamole/launch", {}, 404],
    ] as Array<["GET" | "POST" | "DELETE", string, Record<string, unknown> | undefined, number]>) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(expected);
    }
  });

  it("users cannot read other users' IAM data", async () => {
    const alice = await login(app, "alice", "Alice-Password-1!");
    const a = { cookie: alice.cookie, "x-csrf-token": alice.csrf };
    for (const [method, url] of [
      ["GET", `/api/users/${adminId}/permissions`],
      ["GET", "/api/groups"],
      ["GET", "/api/roles"],
      ["GET", "/api/iam/matrix"],
    ] as Array<["GET", string]>) {
      const res = await app.inject({ method, url, headers: { cookie: a.cookie } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    void auth;
  });

  it("expired group role grants stop working", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const gid = "bbbbbbbb-1111-4111-8111-111111111111";
    await ctx.db.query("INSERT INTO groups (id, name) VALUES ($1, 'expired-role-group')", [gid]);
    await ctx.db.query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [gid, aliceId]);
    await ctx.db.query("INSERT INTO group_roles (group_id, role_id, expires_at) VALUES ($1, $2, $3)", [
      gid,
      "00000000-0000-0000-0000-000000000102",
      past,
    ]);
    const check = await app.inject({
      method: "GET",
      url: "/api/authorization/check?permission=vm.start",
      headers: { cookie: (await login(app, "alice", "Alice-Password-1!")).cookie },
    });
    expect(check.statusCode).toBe(200);
    expect((check.json() as { allowed: boolean }).allowed).toBe(false);
    await ctx.db.query("DELETE FROM groups WHERE id = $1", [gid]);
  });

  it("group VM grant to nonexistent VM fails cleanly", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: auth(admin),
      payload: { name: "ghost-group" },
    });
    const groupId = (create.json() as { group: { id: string } }).group.id;
    const grant = await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/vms`,
      headers: auth(admin),
      payload: { vmId: "11111111-1111-4111-8111-111111111111" },
    });
    expect(grant.statusCode).toBe(404);
    await app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, headers: auth(admin) });
  });

  it("deleted role revokes conferred access immediately", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth(admin),
      payload: { name: "TempPower", permissions: ["vm.delete"] },
    });
    const roleId = (create.json() as { role: { id: string } }).role.id;
    await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/roles`,
      headers: auth(admin),
      payload: { roleId },
    });
    let check = await app.inject({
      method: "GET",
      url: "/api/authorization/check?permission=vm.delete",
      headers: { cookie: (await login(app, "alice", "Alice-Password-1!")).cookie },
    });
    expect((check.json() as { allowed: boolean }).allowed).toBe(true);
    await app.inject({ method: "DELETE", url: `/api/roles/${roleId}`, headers: auth(admin) });
    check = await app.inject({
      method: "GET",
      url: "/api/authorization/check?permission=vm.delete",
      headers: { cookie: (await login(app, "alice", "Alice-Password-1!")).cookie },
    });
    expect((check.json() as { allowed: boolean }).allowed).toBe(false);
  });

  it("expired direct grant denies even with a live role grant", async () => {
    // Role gives vm.stop; direct grant expired. Effective set still has
    // vm.stop via role — direct expiry must not poison the role grant.
    const role = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth(admin),
      payload: { name: "Stopper", permissions: ["vm.stop"] },
    });
    const roleId = (role.json() as { role: { id: string } }).role.id;
    await app.inject({
      method: "POST",
      url: `/api/users/${aliceId}/roles`,
      headers: auth(admin),
      payload: { roleId },
    });
    await ctx.db.query(
      "INSERT INTO user_permissions (user_id, permission, expires_at) VALUES ($1, 'vm.stop', NOW() - interval '1 minute') ON CONFLICT (user_id, permission) DO UPDATE SET expires_at = EXCLUDED.expires_at",
      [aliceId],
    );
    const check = await app.inject({
      method: "GET",
      url: "/api/authorization/check?permission=vm.stop",
      headers: { cookie: (await login(app, "alice", "Alice-Password-1!")).cookie },
    });
    expect((check.json() as { allowed: boolean; reason: string }).allowed).toBe(true);
    await app.inject({ method: "DELETE", url: `/api/roles/${roleId}`, headers: auth(admin) });
    await ctx.db.query("DELETE FROM user_permissions WHERE user_id = $1 AND permission = $2", [aliceId, "vm.stop"]);
  });
});
