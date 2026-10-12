import { describe, expect, it, beforeAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import { createCore, hashPassword, jobAuditActor, type CoreContext, type LocalConfig } from "./index.js";

const masterKey = "a".repeat(64);

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

describe("jobAuditActor", () => {
  let ctx: CoreContext;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, { db: pool, redis: new RedisMock() as never, logger: silentLogger });
  });

  it("attributes pipeline events to the job creator", async () => {
    const creator = await ctx.users.create({
      username: "provisioner",
      passwordHash: await hashPassword("Provision-Pass-1!"),
      roles: ["ADMIN"],
    });
    const job = await ctx.jobs.create({ vmId: null, request: {}, createdByUserId: creator.id });
    await expect(jobAuditActor(ctx, job.id)).resolves.toEqual({
      actorUserId: creator.id,
      actorUsername: "provisioner",
    });
  });

  it("falls back to anonymous when the job has no creator", async () => {
    const job = await ctx.jobs.create({ vmId: null, request: {}, createdByUserId: null });
    await expect(jobAuditActor(ctx, job.id)).resolves.toEqual({ actorUserId: null, actorUsername: null });
  });

  it("falls back to anonymous when the creator row is gone (FK is ON DELETE SET NULL)", async () => {
    const creator = await ctx.users.create({
      username: "temp-creator",
      passwordHash: await hashPassword("Temp-Password-1!"),
      roles: ["ADMIN"],
    });
    const job = await ctx.jobs.create({ vmId: null, request: {}, createdByUserId: creator.id });
    await ctx.users.delete(creator.id);
    await expect(jobAuditActor(ctx, job.id)).resolves.toEqual({ actorUserId: null, actorUsername: null });
  });
});
