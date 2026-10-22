// Self-serve registration modes end-to-end through the API: closed refuses,
// approval queues, approval ignores turnstile when it's not configured,
// auto creates the account with the zero-permission GUEST role, and the
// Turnstile gate is enforced whenever a secret is configured (fail closed).
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { createCore, makeLogger, hashPassword, type CoreContext, type LocalConfig } from "@proxvm/core";
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

const registration = (
  username: string,
  ip = "203.0.113.1",
  extra: Record<string, unknown> = {},
): { payload: Record<string, unknown>; injectOptions: Record<string, unknown> } => ({
  payload: { username, password: "Self-Serve-1!", ...extra },
  // Distinct source IP per call: the register route rate-limits 5/min/IP,
  // and these tests make several sequential registrations deliberately.
  injectOptions: { remoteAddress: ip, headers: { host: "proxvm.test" } },
});

describe("self-serve registration modes", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;

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
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  it("register-config reports approval by default and public keys only", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/register-config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: "approval", turnstileSiteKey: null });
  });

  it("approval mode (default) queues a request and creates no user", async () => {
    const { payload, injectOptions } = registration("queued-user", "203.0.113.1");
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload, ...injectOptions });
    expect(res.statusCode).toBe(201);
    const pendings = await ctx.registration.list("pending");
    expect(pendings.map((p) => p.username)).toContain("queued-user");
    expect(await ctx.users.findByUsername("queued-user")).toBeNull();
  });

  it("closed mode refuses registration outright", async () => {
    await ctx.settings.set("selfserve.mode", "closed", { category: "system" });
    const { payload, injectOptions } = registration("blocked-user", "203.0.113.2");
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload, ...injectOptions });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "REGISTRATION_CLOSED" });
    expect(await ctx.users.findByUsername("blocked-user")).toBeNull();
    await ctx.settings.set("selfserve.mode", "approval", { category: "system" });
  });

  it("auto WITH a passing Turnstile check creates an instant GUEST account", async () => {
    await ctx.settings.set("selfserve.mode", "auto", { category: "system" });
    await ctx.settings.set("selfserve.turnstile_secret", "test-secret", { encrypted: true, category: "system" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true, action: "signup", hostname: "proxvm.test" }), { status: 200 })),
    );
    const { payload, injectOptions } = registration("instant-user", "203.0.113.3", { turnstileToken: "tok-1" });
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload, ...injectOptions });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, autoApproved: true });
    const user = await ctx.users.findByUsername("instant-user");
    expect(user).not.toBeNull();
    expect(user!.roles).toEqual(["GUEST"]);
    // No queue row: auto mode skips the pending table entirely.
    expect((await ctx.registration.list("pending")).map((p) => p.username)).not.toContain("instant-user");
  });

  it("auto enforces the Turnstile gate: no token and failed siteverify both 4xx, no account", async () => {
    const { payload, injectOptions } = registration("no-token-user", "203.0.113.4");
    const stillNoUser = await app.inject({ method: "POST", url: "/api/auth/register", payload, ...injectOptions });
    expect(stillNoUser.statusCode).toBe(400);
    expect(stillNoUser.json()).toMatchObject({ code: "TURNSTILE_REQUIRED" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })),
    );
    const { payload: payload2, injectOptions: inject2 } = registration("bad-token-user", "203.0.113.5", { turnstileToken: "tok-2" });
    const rejected = await app.inject({ method: "POST", url: "/api/auth/register", payload: payload2, ...inject2 });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ code: "TURNSTILE_FAILED" });

    expect(await ctx.users.findByUsername("no-token-user")).toBeNull();
    expect(await ctx.users.findByUsername("bad-token-user")).toBeNull();
  });

  it("rejects a token solved for another action or on another hostname", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true, action: "login", hostname: "proxvm.test" }), { status: 200 })),
    );
    const wrongAction = registration("wrong-action-user", "203.0.113.7", { turnstileToken: "tok-3" });
    const actionRes = await app.inject({ method: "POST", url: "/api/auth/register", payload: wrongAction.payload, ...wrongAction.injectOptions });
    expect(actionRes.statusCode).toBe(400);
    expect(actionRes.json()).toMatchObject({ code: "TURNSTILE_FAILED" });
    expect(await ctx.users.findByUsername("wrong-action-user")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true, action: "signup", hostname: "evil.example.net" }), { status: 200 })),
    );
    const wrongHost = registration("wrong-host-user", "203.0.113.8", { turnstileToken: "tok-4" });
    const hostRes = await app.inject({ method: "POST", url: "/api/auth/register", payload: wrongHost.payload, ...wrongHost.injectOptions });
    expect(hostRes.statusCode).toBe(400);
    expect(hostRes.json()).toMatchObject({ code: "TURNSTILE_FAILED" });
    expect(await ctx.users.findByUsername("wrong-host-user")).toBeNull();
  });

  it("GUEST grants nothing: the created account has zero effective permissions", async () => {
    const { resolveEffectiveAccess } = await import("@proxvm/core");
    const user = await ctx.users.findByUsername("instant-user");
    const effective = await resolveEffectiveAccess(ctx.db, user!.id);
    expect(effective.permissions.size).toBe(0);
  });

  it("a configured secret gates ALL modes uniformly (no approval-mode bypass)", async () => {
    // Restoring approval: the manual queue is not a free pass around the bot
    // gate — if the server has a secret, token-less registration fails in
    // every mode, otherwise bots would just aim at the slower path.
    await ctx.settings.set("selfserve.mode", "approval", { category: "system" });
    vi.unstubAllGlobals();
    const { payload, injectOptions } = registration("late-arrival", "203.0.113.6");
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload, ...injectOptions });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "TURNSTILE_REQUIRED" });
  });
});
