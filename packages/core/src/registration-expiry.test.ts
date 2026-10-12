import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import { createCore, hashPassword, type CoreContext, type LocalConfig, REGISTRATION_PENDING_MAX_MS } from "./index.js";

const masterKey = "g".repeat(64);

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

const silentLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as never;

describe("registration expiration enforcement", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMock() as never,
      logger: silentLogger,
    });
    cleanup = async () => {
      await pool.end().catch(() => undefined);
    };
    await ctx.users.create({
      username: "registrar",
      passwordHash: await hashPassword("Registrar-Pass-1!"),
      roles: ["ADMIN"],
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("stale pending requests cannot be approved (and are pruned inline)", async () => {
    const created = await ctx.registration.request({
      username: "stale-user",
      passwordHash: await hashPassword("Stale-Password-1!"),
    });
    const ancient = new Date(Date.now() - REGISTRATION_PENDING_MAX_MS - 1000).toISOString();
    await ctx.db.query("UPDATE registration_requests SET created_at = $1 WHERE id = $2", [ancient, created.id]);
    const admin = (await ctx.users.findByUsername("registrar"))!;
    await expect(ctx.registration.approve(created.id, admin.id, ["USER"])).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await ctx.users.findByUsername("stale-user")).toBeNull();
    // Inline prune freed the username: a fresh request works.
    const retry = await ctx.registration.request({
      username: "stale-user",
      passwordHash: await hashPassword("Fresh-Password-1!"),
    });
    expect(retry.status).toBe("pending");
  });

  it("fresh requests still approve normally", async () => {
    const created = await ctx.registration.request({
      username: "fresh-user",
      passwordHash: await hashPassword("Fresh-Password-1!"),
    });
    const admin = (await ctx.users.findByUsername("registrar"))!;
    const { userId } = await ctx.registration.approve(created.id, admin.id, ["USER"]);
    expect((await ctx.users.findById(userId))?.username).toBe("fresh-user");
  });
});
