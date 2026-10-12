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

async function loginAs(app: Awaited<ReturnType<typeof buildApp>>, username: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "proxvm_session");
  return {
    cookie: `${cookie?.name}=${cookie?.value}`,
    "x-csrf-token": (res.json() as { csrfToken: string }).csrfToken,
  };
}

describe("privacy-flag isolation invariants", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminAuth: Record<string, string>;
  let aliceAuth: Record<string, string>;
  let malloryAuth: Record<string, string>;
  let malloryId = "";
  let aliceId = "";
  let vmId = "";

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    await ctx.users.create({ username: "admin", passwordHash: await hashPassword("Admin-Password-1!"), roles: ["ADMIN"] });
    const alice = await ctx.users.create({ username: "alice", passwordHash: await hashPassword("User-Password-1!"), roles: ["USER"] });
    aliceId = alice.id;
    const mallory = await ctx.users.create({ username: "mallory", passwordHash: await hashPassword("Mallory-Pass-1!"), roles: ["USER"] });
    malloryId = mallory.id;
    const vm = await ctx.vms.create({ vmid: 401, node: "node1", name: "private-vm", status: "stopped", createdByUserId: aliceId });
    vmId = vm.id;
    await ctx.vms.setPrivacyFlag(vm.id, true);
    app = await buildApp({ setupMode: false, ctx });
    adminAuth = await loginAs(app, "admin", "Admin-Password-1!");
    aliceAuth = await loginAs(app, "alice", "User-Password-1!");
    malloryAuth = await loginAs(app, "mallory", "Mallory-Pass-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  it("group-VM grants to private VMs need a concrete grant", async () => {
    const group = await app.inject({ method: "POST", url: "/api/groups", headers: adminAuth, payload: { name: "g1" } });
    expect(group.statusCode).toBe(200);
    const groupId = (group.json() as { group: { id: string } }).group.id;
    const grant = await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/vms`,
      headers: adminAuth,
      payload: { vmId },
    });
    expect(grant.statusCode).toBe(403);
  });

  it("credential inventory hides private VMs without a grant", async () => {
    // Custom cred.reveal-only role for mallory.
    const role = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: adminAuth,
      payload: { name: "RevealOnly", permissions: ["cred.reveal"] },
    });
    expect(role.statusCode).toBe(200);
    const roleId = (role.json() as { role: { id: string } }).role.id;
    expect(
      (await app.inject({ method: "POST", url: `/api/users/${malloryId}/roles`, headers: adminAuth, payload: { roleId } })).statusCode,
    ).toBe(200);
    await ctx.creds.store(vmId, "deploy", "First-Password-1!", "ENCRYPTED");

    const hidden = await app.inject({ method: "GET", url: "/api/credentials", headers: { cookie: malloryAuth.cookie } });
    expect(hidden.statusCode).toBe(200);
    expect((hidden.json() as { credentials: Array<{ vmId: string }> }).credentials.map((c) => c.vmId)).not.toContain(vmId);

    expect(
      (await app.inject({ method: "POST", url: `/api/users/${aliceId}/roles`, headers: adminAuth, payload: { roleId } })).statusCode,
    ).toBe(200);
    const owner = await app.inject({ method: "GET", url: "/api/credentials", headers: { cookie: aliceAuth.cookie } });
    expect(owner.statusCode).toBe(200);
    expect((owner.json() as { credentials: Array<{ vmId: string }> }).credentials.map((c) => c.vmId)).toContain(vmId);
  });

  it("creators see their own jobs on private VMs", async () => {
    const job = await ctx.jobs.create({ vmId, request: {}, createdByUserId: aliceId });
    const list = await app.inject({ method: "GET", url: "/api/jobs?limit=50", headers: { cookie: aliceAuth.cookie } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)).toContain(job.id);
  });

  it("deleted VMs stop leaking previously-private audit history", async () => {
    // Owner needs audit.read to view the log at all.
    const role = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: adminAuth,
      payload: { name: "AuditReader", permissions: ["audit.read"] },
    });
    expect(role.statusCode).toBe(200);
    const roleId = (role.json() as { role: { id: string } }).role.id;
    expect(
      (await app.inject({ method: "POST", url: `/api/users/${aliceId}/roles`, headers: adminAuth, payload: { roleId } })).statusCode,
    ).toBe(200);
    await ctx.audit.record({ event: "VM_EDITED", actorUserId: aliceId, actorUsername: "alice", vmId });
    // Owner sees history while the VM exists...
    const before = await app.inject({ method: "GET", url: `/api/audit?vmId=${vmId}`, headers: aliceAuth });
    expect(before.statusCode).toBe(200);
    expect((before.json() as { entries: unknown[] }).entries.length).toBeGreaterThan(0);

    await ctx.vms.softDelete(vmId);
    // ...and nobody does after deletion (grants die with the row).
    for (const headers of [aliceAuth, adminAuth]) {
      const after = await app.inject({ method: "GET", url: `/api/audit?vmId=${vmId}`, headers });
      expect(after.statusCode).toBe(200);
      expect((after.json() as { entries: unknown[] }).entries).toHaveLength(0);
    }
  });
});
