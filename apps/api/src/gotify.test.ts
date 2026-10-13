import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
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

describe("gotify settings", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminCookie: string;
  let adminCsrf: string;

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
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  const auth = () => ({ cookie: adminCookie, "x-csrf-token": adminCsrf });

  it("rejects non-http(s) and loopback gotify URLs", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: auth(),
      payload: { gotifyUrl: "ftp://example.com/hook" },
    });
    expect(bad.statusCode).toBe(400);
    const loopback = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: auth(),
      payload: { gotifyUrl: "http://127.0.0.1/" },
    });
    expect(loopback.statusCode).toBe(400);
  });

  it("rejects out-of-range priorities", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: auth(),
      payload: { gotifyPriority: 11 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("stores gotify config and never reveals the token", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: auth(),
      payload: {
        gotifyUrl: "http://192.168.1.28/",
        gotifyToken: "s3cret-value",
        gotifyPriority: 8,
        gotifyEnabled: true,
      },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/settings/app", headers: { cookie: adminCookie } });
    expect(get.statusCode).toBe(200);
    expect(get.json() as object).toMatchObject({
      settings: {
        gotifyUrl: "http://192.168.1.28",
        gotifyPriority: 8,
        gotifyEnabled: true,
        gotifyConfigured: true,
      },
    });
    // The token must never round-trip through any read surface.
    expect(JSON.stringify(get.json())).not.toContain("s3cret-value");
  });

  it("sends a test push when configured, 400 when not", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const ok = await app.inject({ method: "POST", url: "/api/settings/gotify/test", headers: auth(), payload: {} });
    expect(ok.statusCode).toBe(200);
    // Clear the token: test must refuse, not attempt delivery.
    const clear = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: auth(),
      payload: { gotifyToken: null },
    });
    expect(clear.statusCode).toBe(200);
    const missing = await app.inject({
      method: "POST",
      url: "/api/settings/gotify/test",
      headers: auth(),
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    vi.unstubAllGlobals();
  });
});
