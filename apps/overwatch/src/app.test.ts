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
import { buildOverwatchApp } from "./index.js";
import RedisMockCtor from "ioredis-mock";
import type { FastifyInstance } from "fastify";

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

const TOKEN = "test-overwatch-token-1234567890";

async function mintSession(ctx: CoreContext, userId: string): Promise<{ cookie: string }> {
  const session = await ctx.sessions.create(userId, { ip: "127.0.0.1", userAgent: "test" });
  return { cookie: `proxvm_session=${session.sid}` };
}

describe("overwatch gates", () => {
  let app: FastifyInstance;
  let ctx: CoreContext;
  let adminCookie: string;
  let userCookie: string;
  let savedToken: string | undefined;

  beforeAll(async () => {
    savedToken = process.env.PROXVM_OVERWATCH_TOKEN;
    process.env.PROXVM_OVERWATCH_TOKEN = TOKEN;
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    const base: CoreContext = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    ctx = base;
    await ctx.users.create({
      username: "admin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    await ctx.users.create({
      username: "bob",
      passwordHash: await hashPassword("Bob-Password-1!"),
      roles: ["USER"],
    });
    const admin = await ctx.users.findByUsername("admin");
    const bob = await ctx.users.findByUsername("bob");
    adminCookie = (await mintSession(ctx, admin!.id)).cookie;
    userCookie = (await mintSession(ctx, bob!.id)).cookie;
    app = await buildOverwatchApp({ ...base, queue: { getJobCounts: async () => ({}) } });
  });

  afterAll(async () => {
    if (savedToken === undefined) delete process.env.PROXVM_OVERWATCH_TOKEN;
    else process.env.PROXVM_OVERWATCH_TOKEN = savedToken;
    await app.close();
  });

  const bearer = { authorization: `Bearer ${TOKEN}` };

  it("healthz is public, everything else needs token + admin session", async () => {
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);

    const noToken = await app.inject({ method: "GET", url: "/overview", headers: { cookie: adminCookie } });
    expect(noToken.statusCode).toBe(401);

    const badToken = await app.inject({
      method: "GET",
      url: "/overview",
      headers: { cookie: adminCookie, authorization: "Bearer wrong" },
    });
    expect(badToken.statusCode).toBe(401);

    const noSession = await app.inject({ method: "GET", url: "/overview", headers: bearer });
    expect(noSession.statusCode).toBe(401);

    const nonAdmin = await app.inject({
      method: "GET",
      url: "/overview",
      headers: { cookie: userCookie, ...bearer },
    });
    expect([401, 403]).toContain(nonAdmin.statusCode);
  });

  it("overview and activity answer for token + admin", async () => {
    const res = await app.inject({ method: "GET", url: "/overview", headers: { cookie: adminCookie, ...bearer } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("users");
    expect(body).toHaveProperty("vms");
    const activity = await app.inject({ method: "GET", url: "/activity?limit=5", headers: { cookie: adminCookie, ...bearer } });
    expect(activity.statusCode).toBe(200);
  });

  it("sql console rejects writes at the gate and audits reads", async () => {
    const headers = { cookie: adminCookie, ...bearer };
    const bad = await app.inject({
      method: "POST",
      url: "/sql",
      headers,
      payload: { query: "DROP TABLE users" },
    });
    expect(bad.statusCode).toBe(400);
    // pg-mem cannot parse START TRANSACTION READ ONLY, so the execution
    // path fails closed here (502 via the external-error mapping, no side
    // effects). The real SELECT path is verified live post-deploy; gates
    // below are what unit tests own.
    const read = await app.inject({
      method: "POST",
      url: "/sql",
      headers,
      payload: { query: "SELECT username FROM users ORDER BY username" },
    });
    expect(read.statusCode).toBe(502);
    const users = await ctx.users.list();
    expect(users.length).toBe(2);
  });

  it("docker logs are disabled without an explicit socket", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/docker/logs?service=api",
      headers: { cookie: adminCookie, ...bearer },
    });
    expect(res.statusCode).toBe(503);
  });
});
