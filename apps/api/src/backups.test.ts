import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { createCore, makeLogger, hashPassword, type CoreContext, type LocalConfig } from "@proxvm/core";
import { buildApp } from "../src/app.js";
import RedisMockCtor from "ioredis-mock";

const masterKey = "9".repeat(64);

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

describe("PBS backup routes", () => {
  let baseCtx: CoreContext;
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let aliceId: string;
  let opId: string;
  let vmId: string;

  const fakePbs = {
    version: async () => ({ version: "4.2.0" }),
    listBackupGroups: async () => [
      { "backup-id": "vm/4242", "backup-type": "vm", "backup-count": 3, "last-backup": 1700000000, files: [{ password: "must-not-leak" }], secret: "must-not-leak" },
    ],
  };

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    const base = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    baseCtx = base;
    ctx = { ...base, getPbsClient: async () => fakePbs as never };
    await ctx.settings.set("pbs.url", "https://pbs.example:8007", { category: "infrastructure" });
    await ctx.settings.set("pbs.token_secret", "test-secret", { encrypted: true, category: "infrastructure" });
    await ctx.settings.set("pbs.datastore", "pbs-data", { category: "infrastructure" });
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
    const op = await ctx.users.create({
      username: "op",
      passwordHash: await hashPassword("Operator-Pass-1!"),
      roles: ["OPERATOR"],
    });
    opId = op.id;
    const vm = await ctx.vms.create({ vmid: 4242, node: "n1", name: "backup-api-vm" });
    vmId = vm.id;
    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (s: Session) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

  it("rejects unauthenticated and under-privileged schedule management", async () => {
    expect((await app.inject({ method: "GET", url: "/api/backups/schedules" })).statusCode).toBe(401);
    const alice = await login(app, "alice", "Alice-Password-1!");
    expect((await app.inject({ method: "GET", url: "/api/backups/schedules", headers: { cookie: alice.cookie } })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/backups/schedules",
          headers: auth(alice),
          payload: { vmId, storage: "pbs-store", hour: 2, minute: 0 },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("validates schedule input", async () => {
    const op = await login(app, "op", "Operator-Pass-1!");
    // No VM access for op yet: grant it so we reach validation, not denial.
    await ctx.db.query("INSERT INTO vm_access (vm_id, user_id) VALUES ($1, $2)", [vmId, opId]);
    for (const payload of [
      { vmId, storage: "pbs-store", hour: 25, minute: 0 },
      { vmId, storage: "pbs-store", hour: 2, minute: 60 },
      { vmId, storage: "pbs-store", hour: 2, minute: 0, mode: "full" },
      { vmId, storage: "bad storage!", hour: 2, minute: 0 },
      { vmId, storage: "pbs-store", hour: 2, minute: 0, days: "8" },
      { vmId, storage: "pbs-store", hour: 2, minute: 0, keepLast: 0 },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/backups/schedules", headers: auth(op), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // Unknown VM denies (no access), never 500.
    const ghost = await app.inject({
      method: "POST",
      url: "/api/backups/schedules",
      headers: auth(op),
      payload: { vmId: "11111111-1111-4111-8111-111111111111", storage: "pbs-store", hour: 2, minute: 0 },
    });
    expect([403, 404]).toContain(ghost.statusCode);
  });

  it("manages schedules end to end with audits", async () => {
    const op = await login(app, "op", "Operator-Pass-1!");
    const created = await app.inject({
      method: "POST",
      url: "/api/backups/schedules",
      headers: auth(op),
      payload: { vmId, storage: "pbs-store", mode: "snapshot", hour: 2, minute: 30, keepLast: 7 },
    });
    expect(created.statusCode).toBe(200);
    const schedule = (created.json() as { schedule: { id: string } }).schedule;
    const list = await app.inject({ method: "GET", url: "/api/backups/schedules", headers: auth(admin) });
    expect((list.json() as { schedules: Array<{ id: string }> }).schedules.map((s) => s.id)).toContain(schedule.id);
    const toggle = await app.inject({
      method: "PATCH",
      url: `/api/backups/schedules/${schedule.id}`,
      headers: auth(op),
      payload: { enabled: false },
    });
    expect(toggle.statusCode).toBe(200);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/backups/schedules/${schedule.id}`,
      headers: auth(op),
    });
    expect(del.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/backups/schedules/${schedule.id}`, headers: auth(op) })).statusCode,
    ).toBe(404);
    const audit = await ctx.audit.list({ vmId, limit: 20 });
    expect(audit.map((a) => a.event)).toEqual(
      expect.arrayContaining(["BACKUP_SCHEDULE_CREATED", "BACKUP_SCHEDULE_UPDATED", "BACKUP_SCHEDULE_DELETED"]),
    );
  });

  it("hides other tenants' schedules from non-admins", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/backups/schedules",
      headers: auth(admin),
      payload: { vmId, storage: "pbs-store", hour: 4, minute: 0 },
    });
    const scheduleId = (created.json() as { schedule: { id: string } }).schedule.id;
    const alice = await login(app, "alice", "Alice-Password-1!");
    // Alice holds no vm.manage at all: denied before visibility even matters.
    expect(
      (await app.inject({ method: "GET", url: "/api/backups/schedules", headers: { cookie: alice.cookie } })).statusCode,
    ).toBe(403);
    await app.inject({ method: "DELETE", url: `/api/backups/schedules/${scheduleId}`, headers: auth(admin) });
  });

  it("queues manual backups and prunes asynchronously (202, never blocking)", async () => {
    const op = await login(app, "op", "Operator-Pass-1!");
    const run = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/backups/run`,
      headers: auth(op),
      payload: { storage: "pbs-store", mode: "snapshot", keepLast: 7 },
    });
    expect(run.statusCode).toBe(202);
    expect((run.json() as { run: { status: string } }).run.status).toBe("PENDING");
    const prune = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/backups/prune`,
      headers: auth(op),
      payload: { keepLast: 5 },
    });
    expect(prune.statusCode).toBe(202);
    // Prune without keepLast is a 400, not a wipe-everything.
    const badPrune = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/backups/prune`,
      headers: auth(op),
      payload: {},
    });
    expect(badPrune.statusCode).toBe(400);
    const runs = await app.inject({ method: "GET", url: `/api/vms/${vmId}/backups/runs`, headers: { cookie: op.cookie } });
    expect(runs.statusCode).toBe(200);
    expect((runs.json() as { runs: unknown[] }).runs.length).toBeGreaterThanOrEqual(2);
    await ctx.db.query("DELETE FROM pbs_backups WHERE vm_id = $1", [vmId]);
  });

  it("denies backup actions without VM access", async () => {
    const alice = await login(app, "alice", "Alice-Password-1!");
    // Alice is a plain USER (no vm.manage): all write paths deny.
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/vms/${vmId}/backups/run`,
          headers: auth(alice),
          payload: { storage: "pbs-store" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: `/api/vms/${vmId}/backups/runs`, headers: { cookie: alice.cookie } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: `/api/vms/${vmId}/backups/snapshots`, headers: { cookie: alice.cookie } }))
        .statusCode,
    ).toBe(403);
    void aliceId;
  });

  it("lists snapshots projected to safe fields", async () => {
    const op = await login(app, "op", "Operator-Pass-1!");
    const res = await app.inject({
      method: "GET",
      url: `/api/vms/${vmId}/backups/snapshots`,
      headers: { cookie: op.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { snapshots: Array<Record<string, unknown>> };
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]).toMatchObject({ backupId: "vm/4242", backupType: "vm", backupCount: 3 });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("returns 503 when PBS is not configured", async () => {    // The main app overrides getPbsClient with a fake, so exercise the
    // unconfigured path through a second app on the real context.
    await ctx.db.query("DELETE FROM settings WHERE key LIKE 'pbs.%'");
    const app2 = await buildApp({ setupMode: false, ctx: baseCtx });
    try {
      const op2 = await login(app2, "op", "Operator-Pass-1!");
      const run = await app2.inject({
        method: "POST",
        url: `/api/vms/${vmId}/backups/run`,
        headers: { cookie: op2.cookie, "x-csrf-token": op2.csrf },
        payload: { storage: "pbs-store" },
      });
      expect(run.statusCode).toBe(503);
    } finally {
      await app2.close();
    }
    await ctx.settings.set("pbs.url", "https://pbs.example:8007", { category: "infrastructure" });
    await ctx.settings.set("pbs.token_secret", "test-secret", { encrypted: true, category: "infrastructure" });
    await ctx.settings.set("pbs.datastore", "pbs-data", { category: "infrastructure" });
  });

  it("bulk-schedules across VMs with per-VM results (partial success)", async () => {
    const op = await login(app, "op", "Operator-Pass-1!");
    const other = await ctx.vms.create({ vmid: 4243, node: "n1", name: "bulk-other" });
    // Privacy-flagged with no grant: even OPERATORs cannot see it, so the
    // bulk op must report it as failed while still creating the rest.
    await ctx.vms.setPrivacyFlag(other.id, true);
    const res = await app.inject({
      method: "POST",
      url: "/api/backups/schedules/bulk",
      headers: auth(op),
      payload: {
        vmIds: [vmId, other.id, "11111111-1111-4111-8111-111111111111"],
        storage: "pbs-store",
        hour: 2,
        minute: 15,
        keepLast: 7,
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { created: Array<{ vmId: string }>; failed: Array<{ vmId: string; error: string }> };
    // vmId: accessible. other: op lacks access. ghost: missing. 1 + 2.
    expect(body.created.map((c) => c.vmId)).toEqual([vmId]);
    expect(body.failed.map((f) => f.vmId).sort()).toEqual(
      [other.id, "11111111-1111-4111-8111-111111111111"].sort(),
    );
    // Malformed body (non-UUID, >50 ids) is a flat 400.
    const bad = await app.inject({
      method: "POST",
      url: "/api/backups/schedules/bulk",
      headers: auth(op),
      payload: { vmIds: ["not-a-uuid"], storage: "pbs-store", hour: 2, minute: 0 },
    });
    expect(bad.statusCode).toBe(400);
    await ctx.db.query("DELETE FROM pbs_backup_schedules WHERE vm_id = $1", [vmId]);
    await ctx.db.query("DELETE FROM vms WHERE id = $1", [other.id]);
  });

  it("bulk-triggers runs and reports over-cap VMs as failures", async () => {
    const op = await login(app, "op", "Operator-Pass-1!");
    // Fill the per-VM cap so the bulk trigger records a failure, not a 500.
    const { randomUUID } = await import("node:crypto");
    for (let i = 0; i < 3; i++) {
      await ctx.db.query(
        "INSERT INTO pbs_backups (id, vm_id, kind, status, created_by) VALUES ($1, $2, 'backup', 'PENDING', $3)",
        [randomUUID(), vmId, opId],
      );
    }
    const res = await app.inject({
      method: "POST",
      url: "/api/backups/run-bulk",
      headers: auth(op),
      payload: { vmIds: [vmId], storage: "pbs-store" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { queued: unknown[]; failed: Array<{ error: string }> };
    expect(body.queued).toHaveLength(0);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]!.error).toMatch(/Too many/);
    await ctx.db.query("DELETE FROM pbs_backups WHERE vm_id = $1", [vmId]);
  });

  it("serves a fleet overview filtered by visibility", async () => {
    const other = await ctx.vms.create({ vmid: 4244, node: "n1", name: "overview-hidden" });
    // Private with no grant: visible to admins, invisible to operators.
    await ctx.vms.setPrivacyFlag(other.id, true);
    const adminRes = await app.inject({ method: "GET", url: "/api/backups/overview", headers: auth(admin) });
    expect(adminRes.statusCode).toBe(200);
    const adminRows = (adminRes.json() as { overview: Array<{ vmId: string; schedules: number }> }).overview;
    expect(adminRows.map((r) => r.vmId)).toEqual(expect.arrayContaining([vmId, other.id]));
    const row = adminRows.find((r) => r.vmId === vmId)!;
    expect(row).toMatchObject({ schedules: 0 });
    expect("lastSnapshot" in row && "snapshotCount" in row).toBe(true);
    // Op only sees the VM it can access.
    const op = await login(app, "op", "Operator-Pass-1!");
    const opRes = await app.inject({ method: "GET", url: "/api/backups/overview", headers: { cookie: op.cookie } });
    expect(opRes.statusCode).toBe(200);
    const opRows = (opRes.json() as { overview: Array<{ vmId: string }> }).overview;
    expect(opRows.map((r) => r.vmId)).toContain(vmId);
    expect(opRows.map((r) => r.vmId)).not.toContain(other.id);
    // Plain users cannot reach the overview at all.
    const alice = await login(app, "alice", "Alice-Password-1!");
    expect((await app.inject({ method: "GET", url: "/api/backups/overview", headers: { cookie: alice.cookie } })).statusCode).toBe(403);
    await ctx.db.query("DELETE FROM vms WHERE id = $1", [other.id]);
  });
});
