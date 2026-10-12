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
import { parseTrustProxy } from "../src/app.js";
import RedisMockCtor from "ioredis-mock";

const masterKey = "f".repeat(64);

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

describe("audit attribution", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminCookie: string;
  let adminCsrf: string;
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
    await ctx.users.create({
      username: "admin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    app = await buildApp({ setupMode: false, ctx });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "Admin-Password-1!" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "proxvm_session");
    adminCookie = `${cookie?.name}=${cookie?.value}`;
    adminCsrf = (login.json() as { csrfToken: string }).csrfToken;
    adminId = (await ctx.users.findByUsername("admin"))!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => ({ cookie: adminCookie, "x-csrf-token": adminCsrf });

  it("parses the trust-proxy setting", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("0")).toBe(false);
    expect(parseTrustProxy("1")).toBe(true);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("172.16.0.0/12, 10.0.0.0/8")).toEqual(["172.16.0.0/12", "10.0.0.0/8"]);
  });

  it("records actor and client IP on mutating actions", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: auth(),
      remoteAddress: "203.0.113.7",
      payload: { username: "bob", password: "Bob-Password-1!", role: "USER" },
    });
    expect(res.statusCode).toBe(200);
    const rows = await ctx.db.query(
      "SELECT event, actor_user_id, actor_username, ip FROM audit_logs WHERE event = 'USER_CREATED'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      event: "USER_CREATED",
      actor_user_id: adminId,
      actor_username: "admin",
      ip: "203.0.113.7",
    });
  });

  it("audits locked-account login attempts with the actor attached", async () => {
    const bobSession = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "bob", password: "Bob-Password-1!" },
    });
    expect(bobSession.statusCode).toBe(200);
    const bobCookie = bobSession.cookies.find((c) => c.name === "proxvm_session");
    const bobAuth = `${bobCookie?.name}=${bobCookie?.value}`;
    await ctx.users.recordFailedLogin("bob", 1, 15);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "203.0.113.8",
      payload: { username: "bob", password: "Bob-Password-1!" },
    });
    // Uniform 401 (enumeration-hardened); the lock is recorded in the audit row below.
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    const rows = await ctx.db.query(
      "SELECT actor_user_id, actor_username, ip, detail FROM audit_logs WHERE event = 'LOGIN_FAILED' ORDER BY created_at DESC LIMIT 1",
    );
    const bob = await ctx.users.findByUsername("bob");
    expect(rows.rows[0]).toMatchObject({ actor_user_id: bob!.id, actor_username: "bob", ip: "203.0.113.8" });
    expect(rows.rows[0].detail).toMatchObject({ reason: "account-locked" });
    // The lock revoked live sessions: the pre-lock session is dead.
    const reused = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: bobAuth } });
    expect(reused.statusCode).toBe(401);
  });

  it("audits disabled-account login attempts", async () => {
    await ctx.db.query("UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE username = 'bob'");
    const off = await app.inject({
      method: "PUT",
      url: `/api/users/${(await ctx.users.findByUsername("bob"))!.id}`,
      headers: auth(),
      payload: { active: false },
    });
    expect(off.statusCode).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "bob", password: "Bob-Password-1!" },
    });
    expect(res.statusCode).toBe(401);
    const rows = await ctx.db.query(
      "SELECT detail FROM audit_logs WHERE event = 'LOGIN_FAILED' ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows.rows[0].detail).toMatchObject({ reason: "account-disabled" });
  });

  it("detects brute force from seeded failures and guards the endpoint", async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.audit.record({
        event: "LOGIN_FAILED",
        actorUsername: "spray-target",
        ip: "203.0.113.99",
        detail: { reason: "bad-password" },
      });
    }
    const res = await app.inject({ method: "GET", url: "/api/threats?days=1", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { findings: Array<{ id: string; severity: string }>; eventsScanned: number };
    expect(body.eventsScanned).toBeGreaterThanOrEqual(5);
    const brute = body.findings.find((f) => f.id === "brute-force-account-spray-target");
    expect(brute?.severity).toBe("high");

    await ctx.audit.record({ event: "LOGIN", actorUsername: "spray-target", ip: "203.0.113.99" });
    const res2 = await app.inject({ method: "GET", url: "/api/threats?days=1", headers: { cookie: adminCookie } });
    const critical = (res2.json() as { findings: Array<{ id: string; severity: string }> }).findings.find(
      (f) => f.id === "compromised-login-spray-target-203-0-113-99",
    );
    expect(critical?.severity).toBe("critical");

    const denied = await app.inject({ method: "GET", url: "/api/threats?days=1" });
    expect(denied.statusCode).toBe(401);
  });

  it("writes SCAN_DETECTED after a 4xx burst but not for login failures", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await app.inject({
        method: "GET",
        url: `/api/definitely-not-here-${i}`,
        headers: { cookie: adminCookie },
        remoteAddress: "203.0.113.50",
      });
      expect(r.statusCode).toBe(404);
    }
    const scans = await ctx.db.query(
      "SELECT actor_username, ip, detail FROM audit_logs WHERE event = 'SCAN_DETECTED' AND ip = '203.0.113.50'",
    );
    expect(scans.rows).toHaveLength(1);
    expect(scans.rows[0].actor_username).toBe("admin");
    expect(scans.rows[0].detail).toMatchObject({ method: "GET", status: 404 });
    expect(Number(scans.rows[0].detail.count)).toBeGreaterThanOrEqual(20);

    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "203.0.113.51",
        payload: { username: "nobody-here", password: "wrong" },
      });
    }
    const excluded = await ctx.db.query(
      "SELECT count(*)::text AS c FROM audit_logs WHERE event = 'SCAN_DETECTED' AND ip = '203.0.113.51'",
    );
    expect(excluded.rows[0].c).toBe("0");
  });

  it("stores, validates, and returns the threat webhook config", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: auth(),
      payload: { threatWebhookUrl: "ftp://example.com/hook" },
    });
    expect(bad.statusCode).toBe(400);

    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: auth(),
      payload: { threatWebhookUrl: "https://hooks.example.com/x", threatMinSeverity: "medium" },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/settings/app", headers: { cookie: adminCookie } });
    expect(get.json() as object).toMatchObject({
      settings: { threatWebhookUrl: "https://hooks.example.com/x", threatMinSeverity: "medium" },
    });

    const clear = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: auth(),
      payload: { threatWebhookUrl: null },
    });
    expect(clear.statusCode).toBe(200);
  });

  it("stores, validates, and returns the provisioning policy config", async () => {
    const badCidr = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: auth(),
      payload: { staticAllowedCidrs: "not-a-cidr" },
    });
    expect(badCidr.statusCode).toBe(400);

    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: auth(),
      payload: { maxCpu: 16, maxRamMb: 32768, maxDiskGb: 500, staticAllowedCidrs: "192.168.1.0/24" },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/settings/app", headers: { cookie: adminCookie } });
    expect(get.json() as object).toMatchObject({
      settings: { maxCpu: 16, maxRamMb: 32768, maxDiskGb: 500, staticAllowedCidrs: "192.168.1.0/24" },
    });

    const clear = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: auth(),
      payload: { maxCpu: null, staticAllowedCidrs: null },
    });
    expect(clear.statusCode).toBe(200);
    const get2 = await app.inject({ method: "GET", url: "/api/settings/app", headers: { cookie: adminCookie } });
    expect(get2.json() as object).toMatchObject({ settings: { maxCpu: null, staticAllowedCidrs: null } });
  });

  it("treats ILIKE filter wildcards literally", async () => {
    // A bare % must match literally nothing (no wildcard expansion).
    const wild = await app.inject({ method: "GET", url: "/api/audit?actor=%", headers: { cookie: adminCookie } });
    expect(wild.statusCode).toBe(200);
    expect((wild.json() as { entries: unknown[] }).entries).toHaveLength(0);
    // ...while a real substring still matches (admin rows exist by now).
    const hit = await app.inject({ method: "GET", url: "/api/audit?actor=adm", headers: { cookie: adminCookie } });
    expect((hit.json() as { entries: unknown[] }).entries.length).toBeGreaterThan(0);
  });

  it("filters the audit log by IP and actor", async () => {
    const byIp = await app.inject({
      method: "GET",
      url: "/api/audit?ip=203.0.113.7",
      headers: { cookie: adminCookie },
    });
    expect(byIp.statusCode).toBe(200);
    const ipEntries = (byIp.json() as { entries: Array<{ event: string; ip: string }> }).entries;
    expect(ipEntries.length).toBeGreaterThan(0);
    for (const e of ipEntries) expect(e.ip).toBe("203.0.113.7");

    const byActor = await app.inject({
      method: "GET",
      url: "/api/audit?actor=adm",
      headers: { cookie: adminCookie },
    });
    expect(byActor.statusCode).toBe(200);
    const actorEntries = (byActor.json() as { entries: Array<{ actorUsername: string | null }> }).entries;
    expect(actorEntries.length).toBeGreaterThan(0);
    for (const e of actorEntries) expect(e.actorUsername).toContain("adm");
  });
});
