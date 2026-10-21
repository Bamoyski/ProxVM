// ---------------------------------------------------------------------------
// drift.test.ts â€” HTTP surface for ground-truth drift (routes/drift.ts).
// Coverage: real authorization (drift.manage deny-by-default for OPERATOR/
// USER, allowed for legacy ADMIN), malformed/malshaped finding ids (400/404,
// never 500), unknown ids, the privacy gate (invisible findings un-actionable),
// CSRF on every mutation, and request-scoped audit attribution (actor +
// redaction) written through app.audit.
// Proxmox is NOT mocked: the manual run endpoint proves fail-open (skipped)
// against an unconfigured core, which is the state the harness runs in.
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import {
  createCore,
  makeLogger,
  hashPassword,
  applyFindings,
  type CoreContext,
  type LocalConfig,
} from "@proxvm/core";
import { buildApp } from "../src/app.js";
import RedisMockCtor from "ioredis-mock";

const masterKey = "8".repeat(64);

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

describe("drift routes", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let operator: Session;
  let plainUser: Session;
  let driftHolder: Session;
  let holderId: string;
  let vmId: string;
  let findingId: string;
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
    const adminUser = await ctx.users.create({ username: "admin", passwordHash: await hashPassword("Admin-Password-1!"), roles: ["ADMIN"] });
    adminId = adminUser.id;
    await ctx.users.create({ username: "op", passwordHash: await hashPassword("Operator-Pass-1!"), roles: ["OPERATOR"] });
    await ctx.users.create({ username: "u1", passwordHash: await hashPassword("User-Pass-1!"), roles: ["USER"] });
    const holder = await ctx.users.create({ username: "drift-holder", passwordHash: await hashPassword("Holder-Pass-1!"), roles: ["USER"] });
    holderId = holder.id;
    // UUID columns in pg-mem reject text params on INSERT: inline the
    // generated ids. This also proves drift.manage is grantable (FK into
    // the permissions catalog, migration 024).
    await ctx.db.query(
      `INSERT INTO user_permissions (user_id, permission) VALUES ('${holderId}', 'drift.manage')`,
    );
    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
    operator = await login(app, "op", "Operator-Pass-1!");
    plainUser = await login(app, "u1", "User-Pass-1!");
    driftHolder = await login(app, "drift-holder", "Holder-Pass-1!");
    const vm = await ctx.vms.create({ vmid: 1200, node: "node1", name: "api-drift-vm", status: "running", osType: "linux" });
    vmId = vm.id;
    // Drift detection is opt-in (it opens SSH connections to guests). The
    // manual-run test below needs the switch ON to reach the orchestrator.
    await ctx.settings.set("drift.enabled", "true", { category: "system" });
  });

  afterAll(async () => {
    await app.close();
  });

  describe("authorization", () => {
    it("guest (unauthenticated) gets 401 on the drift board", async () => {
      const res = await app.inject({ method: "GET", url: "/api/drift" });
      expect(res.statusCode).toBe(401);
    });

    it("OPERATOR and USER get 403 (drift.manage is deny-by-default)", async () => {
      for (const session of [operator, plainUser]) {
        const board = await app.inject({ method: "GET", url: "/api/drift", headers: { cookie: session.cookie } });
        expect(board.statusCode, session === operator ? "operator" : "user").toBe(403);
        const runPost = await app.inject({
          method: "POST",
          url: "/api/drift/run",
          headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
          payload: {},
        });
        expect(runPost.statusCode).toBe(403);
      }
    });

    it("missing CSRF token returns 403 on mutations even for ADMIN", async () => {
      const res = await app.inject({ method: "POST", url: "/api/drift/run", headers: { cookie: admin.cookie }, payload: {} });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("board + run", () => {
    it("ADMIN sees the board (empty start) and gets lastRun null before any pass", async () => {
      const res = await app.inject({ method: "GET", url: "/api/drift", headers: { cookie: admin.cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { findings: unknown[]; lastRun: unknown };
      expect(Array.isArray(body.findings)).toBe(true);
      expect(body.lastRun).toBeNull();
    });

    it("the board reports whether the feature is enabled at all", async () => {
      // An empty board with no banner reads as "no drift detected" when in
      // truth nothing was ever checked. The API has to say which it is.
      const on = await app.inject({ method: "GET", url: "/api/drift", headers: { cookie: admin.cookie } });
      expect((on.json() as { enabled: boolean }).enabled).toBe(true);
      await ctx.settings.set("drift.enabled", "false", { category: "system" });
      try {
        const off = await app.inject({ method: "GET", url: "/api/drift", headers: { cookie: admin.cookie } });
        expect(off.statusCode).toBe(200);
        expect((off.json() as { enabled: boolean }).enabled).toBe(false);
        // A disabled feature is not persisted as a skipped run, so lastRun
        // stays null and the UI has to rely on `enabled`.
        expect((off.json() as { lastRun: unknown }).lastRun).toBeNull();
      } finally {
        await ctx.settings.set("drift.enabled", "true", { category: "system" });
      }
    });

    it("manual run fails open: unconfigured Proxmox reports 'unconfigured' (never 500)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/drift/run",
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ skipped: "unconfigured", liveChecked: false, created: 0 });
    });

    it("findings created below the routes surface through the board with vm fields", async () => {
      const result = await applyFindings(ctx.db, [
        { fingerprint: `config:${vmId}:name`, dimension: "config", severity: "low", vmId, title: "t", summary: "s", detail: { field: "name" } },
      ], { now: new Date(), resolveStale: false });
      expect(result.created).toBe(1);
      const res = await app.inject({ method: "GET", url: "/api/drift", headers: { cookie: admin.cookie } });
      const body = res.json() as { findings: Array<{ id: string; vmId: string | null; dimension: string }> };
      const row = body.findings.find((f) => f.vmId === vmId);
      expect(row).toBeDefined();
      expect(row!.dimension).toBe("config");
      findingId = row!.id;
    });
  });

  describe("malformed + unknown ids", () => {
    it("malformed finding ids fail zod validation (400 VALIDATION_ERROR, never 500)", async () => {
      const ack = await app.inject({
        method: "POST",
        url: "/api/drift/findings/not-a-uuid/acknowledge",
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: {},
      });
      expect(ack.statusCode).toBe(400);
      expect(ack.json()).toMatchObject({ code: "VALIDATION_ERROR" });
      // Path-traversal-shaped URLs are normalized away by the router and
      // match no route at all â€” 404, never 500.
      const rem = await app.inject({
        method: "POST",
        url: "/api/drift/findings/../../etc/passwd/remediate",
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: { action: "adopt" },
      });
      expect(rem.statusCode).toBe(404);
    });

    it("well-formed unknown ids return 404", async () => {
      const missing = "22222222-2222-4222-8222-222222222222";
      const ack = await app.inject({
        method: "POST",
        url: `/api/drift/findings/${missing}/acknowledge`,
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: {},
      });
      expect(ack.statusCode).toBe(404);
      const rem = await app.inject({
        method: "POST",
        url: `/api/drift/findings/${missing}/remediate`,
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: { action: "adopt" },
      });
      expect(rem.statusCode).toBe(404);
    });

    it("unknown remediation actions are rejected (400)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/drift/findings/${findingId}/remediate`,
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: { action: "rm -rf" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("destructive remediation is confirmed and permission-scoped", () => {
    it("decommission without the typed confirmation is refused (400)", async () => {
      // A confirmation that lives only in the browser is not a control: the
      // API enforces the token itself.
      await applyFindings(ctx.db, [
        { fingerprint: `deleted:${vmId}`, dimension: "deleted", severity: "high", vmId, title: "t", summary: "s" },
      ], { now: new Date(), resolveStale: false });
      const board = await app.inject({ method: "GET", url: "/api/drift", headers: { cookie: admin.cookie } });
      const row = (board.json() as { findings: Array<{ id: string; dimension: string }> }).findings.find(
        (f) => f.dimension === "deleted",
      )!;
      const res = await app.inject({
        method: "POST",
        url: `/api/drift/findings/${row.id}/remediate`,
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: { action: "decommission" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
      // The wrong token is refused too.
      const wrong = await app.inject({
        method: "POST",
        url: `/api/drift/findings/${row.id}/remediate`,
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: { action: "decommission", confirmText: "DECOMMISSION wrong-name" },
      });
      expect(wrong.statusCode).toBe(400);
      // The record is untouched.
      expect(await ctx.vms.findById(vmId)).not.toBeNull();
    });

    it("drift.manage alone cannot decommission (the blast radius needs vm.delete + guac.manage)", async () => {
      await applyFindings(ctx.db, [
        { fingerprint: `deleted:${vmId}`, dimension: "deleted", severity: "high", vmId, title: "t", summary: "s" },
      ], { now: new Date(), resolveStale: false });
      const board = await app.inject({ method: "GET", url: "/api/drift", headers: { cookie: admin.cookie } });
      const row = (board.json() as { findings: Array<{ id: string; dimension: string }> }).findings.find(
        (f) => f.dimension === "deleted",
      )!;
      // The holder needs a grant to even SEE the finding, otherwise it reads
      // as 404 (invisible) - which is an even stronger guarantee.
      await ctx.vms.setAccess(vmId, holderId);
      const res = await app.inject({
        method: "POST",
        url: `/api/drift/findings/${row.id}/remediate`,
        headers: { cookie: driftHolder.cookie, "x-csrf-token": driftHolder.csrf },
        payload: { action: "decommission", confirmText: "DECOMMISSION api-drift-vm" },
      });
      expect(res.statusCode).toBe(403);
      expect(await ctx.vms.findById(vmId)).not.toBeNull();
      await ctx.db.query("DELETE FROM vm_access WHERE vm_id = $1 AND user_id = $2", [vmId, holderId]);
    });
  });

  describe("audit", () => {
    it("acknowledge returns ACKNOWLEDGED and writes a request-attributed audit row without secrets", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/drift/findings/${findingId}/acknowledge`,
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ACKNOWLEDGED" });

      const rows = await ctx.db.query<{ event: string; actor_user_id: string | null; detail: unknown }>(
        "SELECT event, actor_user_id, detail FROM audit_logs ORDER BY created_at DESC LIMIT 5",
      );
      const ackEvent = rows.rows.find((r) => r.event === "DRIFT_FINDING_ACKNOWLEDGED");
      expect(ackEvent).toBeDefined();
      expect(ackEvent!.actor_user_id).toBe(adminId); // app.audit(request, ...) attribution
      expect(JSON.stringify(rows.rows)).not.toMatch(/password/i); // redaction policy
    });

    it("re-acknowledge is idempotent and emits no second audit event", async () => {
      const before = await ctx.db.query<{ c: string }>(
        "SELECT COUNT(*)::text AS c FROM audit_logs WHERE event = 'DRIFT_FINDING_ACKNOWLEDGED'",
      );
      const res = await app.inject({
        method: "POST",
        url: `/api/drift/findings/${findingId}/acknowledge`,
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const after = await ctx.db.query<{ c: string }>(
        "SELECT COUNT(*)::text AS c FROM audit_logs WHERE event = 'DRIFT_FINDING_ACKNOWLEDGED'",
      );
      expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
    });
  });

  describe("privacy + multi-tenant visibility", () => {
    it("a non-privileged drift.manage holder needs a VM grant to see or action findings", async () => {
      // No vm_access yet: the finding exists, but the holder's board excludes
      // it and every mutation reads as not-found (never "exists but denied").
      const before = await app.inject({ method: "GET", url: "/api/drift", headers: { cookie: driftHolder.cookie } });
      expect(before.statusCode).toBe(200);
      expect((before.json() as { findings: Array<{ vmId: string | null }> }).findings.some((f) => f.vmId === vmId)).toBe(false);

      const denied = await app.inject({
        method: "POST",
        url: `/api/drift/findings/${findingId}/acknowledge`,
        headers: { cookie: driftHolder.cookie, "x-csrf-token": driftHolder.csrf },
        payload: {},
      });
      expect(denied.statusCode).toBe(404);

      await ctx.db.query(`INSERT INTO vm_access (vm_id, user_id) VALUES ('${vmId}', '${holderId}')`);
      const after = await app.inject({ method: "GET", url: "/api/drift", headers: { cookie: driftHolder.cookie } });
      expect((after.json() as { findings: Array<{ vmId: string | null }> }).findings.some((f) => f.vmId === vmId)).toBe(true);

      const allowed = await app.inject({
        method: "POST",
        url: `/api/drift/findings/${findingId}/acknowledge`,
        headers: { cookie: driftHolder.cookie, "x-csrf-token": driftHolder.csrf },
        payload: {},
      });
      expect(allowed.statusCode).toBe(200);
    });

    it("privacy-flagged VMs require a concrete grant, even for ADMIN with drift.manage", async () => {
      await ctx.vms.setPrivacyFlag(vmId, true);
      try {
        const adminBoard = await app.inject({ method: "GET", url: "/api/drift", headers: { cookie: admin.cookie } });
        expect((adminBoard.json() as { findings: Array<{ vmId: string | null }> }).findings.some((f) => f.vmId === vmId)).toBe(false);

        const adminDenied = await app.inject({
          method: "POST",
          url: `/api/drift/findings/${findingId}/acknowledge`,
          headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
          payload: {},
        });
        expect(adminDenied.statusCode).toBe(404);
        const untouched = await ctx.db.query<{ status: string }>("SELECT status FROM drift_findings WHERE id = $1", [findingId]);
        expect(untouched.rows[0]?.status).toBe("ACKNOWLEDGED"); // denial changed nothing

        // The holder's direct vm_access grant is the concrete authorization
        // the privacy flag requires â€” it survives the flag.
        const holderBoard = await app.inject({ method: "GET", url: "/api/drift", headers: { cookie: driftHolder.cookie } });
        expect((holderBoard.json() as { findings: Array<{ vmId: string | null }> }).findings.some((f) => f.vmId === vmId)).toBe(true);
      } finally {
        await ctx.vms.setPrivacyFlag(vmId, false);
      }
    });
  });
});
