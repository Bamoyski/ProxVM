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

const masterKey = "e".repeat(64);

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

describe("VM user-access management API", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let operator: Session;
  let alice: Session;
  let bobId: string;
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
    const bob = await ctx.users.create({
      username: "bob",
      passwordHash: await hashPassword("Bob-Password-1!"),
      roles: ["USER"],
    });
    bobId = bob.id;

    const vm = await ctx.vms.create({
      vmid: 301,
      node: "node1",
      name: "access-vm",
      status: "stopped",
      osType: "linux",
    });
    vmId = vm.id;
    await ctx.vms.setAccess(vm.id, aliceId, null);

    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
    operator = await login(app, "op", "Operator-Pass-1!");
    alice = await login(app, "alice", "Alice-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  it("admin and operator can list access; USER gets 403", async () => {
    for (const s of [admin, operator]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/vms/${vmId}/access`,
        headers: { cookie: s.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { access: Array<{ user: { username: string } }> };
      expect(body.access.map((a) => a.user.username)).toContain("alice");
    }
    const denied = await app.inject({
      method: "GET",
      url: `/api/vms/${vmId}/access`,
      headers: { cookie: alice.cookie },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("USER cannot grant or revoke access (403), even for themselves", async () => {
    const grant = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/access`,
      headers: { cookie: alice.cookie, "x-csrf-token": alice.csrf },
      payload: { userId: aliceId },
    });
    expect(grant.statusCode).toBe(403);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/vms/${vmId}/access/${bobId}`,
      headers: { cookie: alice.cookie, "x-csrf-token": alice.csrf },
    });
    expect(revoke.statusCode).toBe(403);
  });

  it("nonexistent VM and user IDs fail cleanly (404); malformed UUID fails (400)", async () => {
    const badVm = await app.inject({
      method: "POST",
      url: `/api/vms/${FAKE_UUID}/access`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { userId: bobId },
    });
    expect(badVm.statusCode).toBe(404);

    const badUser = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/access`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { userId: FAKE_UUID },
    });
    expect(badUser.statusCode).toBe(404);

    const badUsername = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/access`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { username: "does-not-exist" },
    });
    expect(badUsername.statusCode).toBe(404);

    const malformed = await app.inject({
      method: "DELETE",
      url: `/api/vms/${vmId}/access/not-a-uuid`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("Guacamole sync failure is reported honestly: no vm_access row, failure audited", async () => {
    // Guacamole is not configured in this test env, so the grant must fail
    // AFTER auth but BEFORE writing vm_access — never a false 200.
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/access`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { userId: bobId },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("CONFIGURATION_ERROR");

    expect(await ctx.vms.hasAccess(vmId, bobId)).toBe(false);

    const audit = await ctx.audit.list({ vmId, limit: 50 });
    const failure = audit.find(
      (a) => a.event === "VM_ACCESS_GRANTED" && (a.detail as Record<string, unknown> | null)?.targetUserId === bobId,
    );
    expect(failure).toBeTruthy();
    expect((failure?.detail as Record<string, unknown>).guacSynced).toBe(false);
  });

  it("revoking a never-assigned user is a safe idempotent no-op (works with Guac down)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/vms/${vmId}/access/${bobId}`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, changed: false, guacSynced: true });
  });

  it("revoking an assigned user removes vm_access and audits the change", async () => {
    // Seed the row directly (Guac is down in tests, so route-level revoke of a
    // row WITH a guac user record would fail at the Guac step by design).
    expect(await ctx.vms.hasAccess(vmId, aliceId)).toBe(true);
    await ctx.vms.revokeAccess(vmId, aliceId);
    expect(await ctx.vms.hasAccess(vmId, aliceId)).toBe(false);

    const list = await app.inject({
      method: "GET",
      url: `/api/vms/${vmId}/access`,
      headers: { cookie: admin.cookie },
    });
    expect((list.json() as { access: unknown[] }).access).toHaveLength(0);
  });

  it("deleting a user removes their VM access (no dangling assignments)", async () => {
    await ctx.vms.setAccess(vmId, bobId, null);
    expect(await ctx.vms.hasAccess(vmId, bobId)).toBe(true);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/users/${bobId}`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
    });
    expect(del.statusCode).toBe(200);
    expect(await ctx.vms.hasAccess(vmId, bobId)).toBe(false);
    expect(await ctx.vms.listAccessUserIds(vmId)).not.toContain(bobId);
  });
});
