import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { createCore, makeLogger, hashPassword, type CoreContext, type LocalConfig } from "@proxvm/core";
import { buildApp } from "../src/app.js";
import RedisMockCtor from "ioredis-mock";

const masterKey = "b".repeat(64);

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

describe("authorization expiry boundaries (API)", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let aliceId: string;
  let vmId: string;

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
    const alice = await ctx.users.create({
      username: "alice",
      passwordHash: await hashPassword("Alice-Password-1!"),
      roles: ["USER"],
    });
    aliceId = alice.id;
    const vm = await ctx.vms.create({ vmid: 901, node: "n1", name: "boundary-vm" });
    vmId = vm.id;
    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (s: Session) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

  it("grant expiring exactly now denies (boundary)", async () => {
    await ctx.db.query("INSERT INTO user_permissions (user_id, permission, expires_at) VALUES ($1, 'vm.delete', NOW()) ON CONFLICT (user_id, permission) DO UPDATE SET expires_at = EXCLUDED.expires_at", [
      aliceId,
    ]);
    const check = await app.inject({
      method: "GET",
      url: "/api/authorization/check?permission=vm.delete",
      headers: { cookie: (await login(app, "alice", "Alice-Password-1!")).cookie },
    });
    expect((check.json() as { allowed: boolean }).allowed).toBe(false);
    await ctx.db.query("DELETE FROM user_permissions WHERE user_id = $1 AND permission = 'vm.delete'", [aliceId]);
  });

  it("expired group-derived ADMIN cannot perform admin actions", async () => {
    // NOTE: legacy system roles (ADMIN/OPERATOR/USER) linked through groups
    // confer nothing at resolution time (fail-closed product limitation —
    // the conferral guards conservatively treat them as conferring admin).
    // Group-derived privilege is therefore tested with a custom role
    // carrying an admin permission, which is the supported path.
    const created = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { name: "BoundaryAdmins", permissions: ["users.manage"] },
    });
    expect(created.statusCode).toBe(200);
    const customRoleId = (created.json() as { role: { id: string } }).role.id;
    const group = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: auth(admin),
      payload: { name: "boundary-admins" },
    });
    const groupId = (group.json() as { group: { id: string } }).group.id;
    await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/roles`,
      headers: auth(admin),
      payload: { roleId: customRoleId },
    });
    await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/members`,
      headers: auth(admin),
      payload: { userId: aliceId },
    });
    let alice = await login(app, "alice", "Alice-Password-1!");
    // Live group grant: admin-only route passes.
    expect((await app.inject({ method: "GET", url: "/api/users", headers: { cookie: alice.cookie } })).statusCode).toBe(200);
    // Expire the group->role link: the permission evaporates immediately, no sweep needed.
    await ctx.db.query("UPDATE group_roles SET expires_at = NOW() - interval '1 minute' WHERE group_id = $1", [groupId]);
    alice = await login(app, "alice", "Alice-Password-1!");
    expect((await app.inject({ method: "GET", url: "/api/users", headers: { cookie: alice.cookie } })).statusCode).toBe(403);
    // Expired grant attempting an administrative WRITE is also denied.
    const attempt = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: alice.cookie, "x-csrf-token": alice.csrf },
      payload: { username: "boundary-evil", password: "Boundary-Evil-1!", role: "USER" },
    });
    expect(attempt.statusCode).toBe(403);
    expect(await ctx.users.findByUsername("boundary-evil")).toBeNull();
    await app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, headers: auth(admin) });
    await app.inject({ method: "DELETE", url: `/api/roles/${customRoleId}`, headers: auth(admin) });
  });

  it("expired direct membership denies while live group VM grant stands", async () => {
    const group = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: auth(admin),
      payload: { name: "boundary-vm-group" },
    });
    const groupId = (group.json() as { group: { id: string } }).group.id;
    await ctx.db.query("INSERT INTO group_vm_access (group_id, vm_id, protocols) VALUES ($1, $2, $3)", [
      groupId,
      vmId,
      ["ssh"],
    ]);
    await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/members`,
      headers: auth(admin),
      payload: { userId: aliceId },
    });
    let alice = await login(app, "alice", "Alice-Password-1!");
    let check = await app.inject({
      method: "GET",
      url: `/api/authorization/check?vmId=${vmId}&protocol=ssh`,
      headers: { cookie: alice.cookie },
    });
    expect((check.json() as { allowed: boolean }).allowed).toBe(true);
    await ctx.db.query("UPDATE group_members SET expires_at = NOW() - interval '1 minute' WHERE group_id = $1 AND user_id = $2", [
      groupId,
      aliceId,
    ]);
    alice = await login(app, "alice", "Alice-Password-1!");
    check = await app.inject({
      method: "GET",
      url: `/api/authorization/check?vmId=${vmId}&protocol=ssh`,
      headers: { cookie: alice.cookie },
    });
    expect((check.json() as { allowed: boolean }).allowed).toBe(false);
    await app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, headers: auth(admin) });
  });

  it("expired VM permission denies launch with access_expired", async () => {
    await ctx.db.query(
      "INSERT INTO vm_access (vm_id, user_id, expires_at) VALUES ($1, $2, NOW() - interval '1 minute') ON CONFLICT (vm_id, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at",
      [vmId, aliceId],
    );
    const alice = await login(app, "alice", "Alice-Password-1!");
    const launch = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/guacamole/launch`,
      headers: auth(alice),
      payload: {},
    });
    expect(launch.statusCode).toBe(403);
    expect((launch.json() as { explanation?: { reason: string } }).explanation?.reason).toBe("access_expired");
  });
});
