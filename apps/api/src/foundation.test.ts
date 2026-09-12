import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { runMigrations, makeLogger, hashPassword } from "@proxvm/core";
import { buildApp } from "../src/app.js";
import { createCore, type CoreContext } from "@proxvm/core";
import RedisMockCtor from "ioredis-mock";

const masterKey = "a".repeat(64);

const localConfig = {
  version: 1 as const,
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

async function createTestContext(): Promise<{ ctx: CoreContext; cleanup: () => Promise<void> }> {
  const mem = newDb();
  const { Pool: MemPool } = mem.adapters.createPg();
  const pool = new MemPool() as unknown as Pool;
  const redis = new RedisMockCtor() as never;
  const logger = makeLogger("test");
  const ctx = await createCore(localConfig, { db: pool, redis, logger });
  return {
    ctx,
    cleanup: async () => {
      await pool.end().catch(() => undefined);
    },
  };
}

function mkTestLogger(_name: string) {
  return {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => makeLogger(_name),
  } as never;
}

describe("api foundation", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const t = await createTestContext();
    ctx = t.ctx;
    cleanup = t.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("migrations create expected tables and role seeds", async () => {
    const roles = await ctx.db.query("SELECT name FROM roles ORDER BY name");
    expect(roles.rows.map((r) => r.name)).toEqual([
      "ADMIN",
      "OPERATOR",
      "Provisioner",
      "USER",
      "VM Manager",
      "VM Operator",
      "Viewer",
    ]);
  });

  it("rejects unauthenticated access to protected routes", async () => {
    const app = await buildApp({ ctx, setupMode: false });
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("setup test endpoints are not an unauthenticated SSRF vector once configured", async () => {
    await ctx.users.create({
      username: "ssrf-admin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    await ctx.users.create({
      username: "ssrf-user",
      passwordHash: await hashPassword("User-Password-1!"),
      roles: ["USER"],
    });
    const app = await buildApp({ ctx, setupMode: false });
    const loginAs = async (username: string, password: string): Promise<string> => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username, password },
      });
      expect(res.statusCode).toBe(200);
      const cookie = res.cookies.find((c) => c.name === "proxvm_session");
      return `${cookie?.name}=${cookie?.value}`;
    };
    const adminCookie = await loginAs("ssrf-admin", "Admin-Password-1!");
    const userCookie = await loginAs("ssrf-user", "User-Password-1!");
    const body = {
      url: "https://192.0.2.1:8006",
      tokenId: "root@pam!test",
      tokenSecret: "bogus-secret-value",
      verifySsl: false,
    };

    const anon = await app.inject({
      method: "POST",
      url: "/api/setup/test-proxmox",
      payload: body,
    });
    expect(anon.statusCode).toBe(401);

    const plain = await app.inject({
      method: "POST",
      url: "/api/setup/test-proxmox",
      headers: { cookie: userCookie },
      payload: body,
    });
    expect(plain.statusCode).toBe(403);

    // ADMIN passes authorization (the bogus target then fails to connect,
    // reported as ok:false — never 401/403).
    const allowed = await app.inject({
      method: "POST",
      url: "/api/setup/test-proxmox",
      headers: { cookie: adminCookie },
      payload: body,
    });
    expect(allowed.statusCode).toBe(200);
    expect((allowed.json() as { ok: boolean }).ok).toBe(false);
    await app.close();
  });

  it("login + session + csrf + logout flow", async () => {
    await ctx.users.create({
      username: "admin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    const app = await buildApp({ setupMode: false, ctx });

    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "Admin-Password-1!" },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json();
    expect(body.user.username).toBe("admin");
    expect(body.csrfToken).toBeTruthy();
    const setCookie = login.cookies.find((c) => c.name === "proxvm_session");
    expect(setCookie).toBeTruthy();
    const cookieHeader = `${setCookie?.name}=${setCookie?.value}`;

    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookieHeader },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.roles).toContain("ADMIN");

    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: cookieHeader },
      payload: {},
    });
    expect(noCsrf.statusCode).toBe(403);

    const withCsrf = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: cookieHeader, "x-csrf-token": body.csrfToken },
      payload: {},
    });
    expect(withCsrf.statusCode).toBe(200);
    await app.close();
  });

  it("locks account after repeated failures", async () => {
    await ctx.users.create({
      username: "lockme",
      passwordHash: await hashPassword("Lock-Me-Password-1!"),
      roles: ["OPERATOR"],
    });
    const app = await buildApp({ setupMode: false, ctx });
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "lockme", password: "nope-nope-nope" },
      });
    }
    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "lockme", password: "nope" },
    });
    expect(locked.statusCode).toBe(423);
    await app.close();
  });

  it("rbac: USER role cannot manage users", async () => {
    const id = await ctx.users.create({
      username: "plainuser",
      passwordHash: await hashPassword("Plain-User-Pass-1!"),
      roles: ["USER"],
    });
    const app = await buildApp({ setupMode: false, ctx });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "plainuser", password: "Plain-User-Pass-1!" },
    });
    const cookie = login.cookies.find((c) => c.name === "proxvm_session");
    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: `${cookie?.name}=${cookie?.value}` },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("audit log records login events with redacted details", async () => {
    const events = await ctx.audit.list({ limit: 100 });
    const loginEvents = events.filter((e) => e.event === "LOGIN" || e.event === "LOGIN_FAILED");
    expect(loginEvents.length).toBeGreaterThan(0);
    for (const entry of events) {
      const json = JSON.stringify(entry.detail ?? {});
      expect(json.toLowerCase()).not.toContain("admin-password");
 expect(json).not.toContain("Plain-User-Pass");
    }
  });

  it("audit sanitize redacts secret-looking detail keys", async () => {
    await ctx.audit.record({
      event: "PASSWORD_CREATED",
      detail: { username: "root", password: "SHOULD-NOT-APPEAR", tokenSecret: "x".repeat(20) },
    });
    const events = await ctx.audit.list({ event: "PASSWORD_CREATED", limit: 1 });
    const detail = JSON.stringify(events[0]?.detail ?? {});
    expect(detail).not.toContain("SHOULD-NOT-APPEAR");
    expect(detail).toContain("[REDACTED]");
  });
});
