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

// Intro splash variant setting (Settings → Appearance).
// WHY this lives on /setup/status: the splash renders before login, so the
// variant has to travel on the already-public boot call. It is presentation
// only — these tests pin the contract (default, validation, permissions) and
// the "never block boot" fallback.

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
    masterKey: "e".repeat(64),
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

describe("intro splash variant", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ctx: CoreContext;
  let admin: Session;
  let operator: Session;

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
      username: "operator",
      passwordHash: await hashPassword("Operator-Password-1!"),
      roles: ["OPERATOR"],
    });
    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
    operator = await login(app, "operator", "Operator-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const authA = () => ({ cookie: admin.cookie, "x-csrf-token": admin.csrf });
  const authO = () => ({ cookie: operator.cookie, "x-csrf-token": operator.csrf });

  it("defaults to no splash, on both the admin read and the public boot call", async () => {
    const cfg = await app.inject({ method: "GET", url: "/api/settings/app", headers: authA() });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json()).toMatchObject({ settings: { introVariant: "none" } });

    const status = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ mode: "ready", introVariant: "none" });
  });

  it("persists the school variant and serves it before login", async () => {
    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: authA(),
      payload: { introVariant: "school" },
    });
    expect(set.statusCode).toBe(200);

    const cfg = await app.inject({ method: "GET", url: "/api/settings/app", headers: authA() });
    expect(cfg.json()).toMatchObject({ settings: { introVariant: "school" } });

    // Unauthenticated: this is what the SPA reads before it knows who you are.
    const status = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.json()).toMatchObject({ introVariant: "school" });

    const reset = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: authA(),
      payload: { introVariant: "none" },
    });
    expect(reset.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/setup/status" })).json()).toMatchObject({
      introVariant: "none",
    });
  });

  it("rejects unknown variants with a validation error (never 500)", async () => {
    for (const value of ["standard", "SCHOOL", "", 42, null]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings/app",
        headers: authA(),
        payload: { introVariant: value },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    // Nothing was written by the rejected requests.
    expect((await app.inject({ method: "GET", url: "/api/setup/status" })).json()).toMatchObject({
      introVariant: "none",
    });
  });

  it("is admin-only", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: authO(),
      payload: { introVariant: "school" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("degrades a corrupt stored value to no splash instead of failing boot", async () => {
    // Simulates a hand-edited/older row: the public boot call must stay 200.
    await ctx.settings.set("ui.intro_variant", "garbage", { category: "app" });
    const status = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ mode: "ready", introVariant: "none" });

    const cfg = await app.inject({ method: "GET", url: "/api/settings/app", headers: authA() });
    expect(cfg.json()).toMatchObject({ settings: { introVariant: "none" } });
  });
});
