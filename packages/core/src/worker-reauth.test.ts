import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  hashPassword,
  runProvisioningJob,
  type CoreContext,
  type LocalConfig,
} from "./index.js";

const masterKey = "w".repeat(64);

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

async function lastFailureReason(ctx: CoreContext, jobId: string): Promise<{ status: string; detail: unknown }> {
  const job = await ctx.jobs.require(jobId);
  const audit = await ctx.audit.list({ limit: 50 });
  const failure = [...audit]
    .reverse()
    .find((a) => a.event === "PROVISIONING_FAILED" && (a as { jobId?: string }).jobId === jobId);
  return { status: job.status, detail: (failure?.detail as Record<string, unknown> | undefined)?.during ?? null };
}

describe("worker re-authorization at execution time", () => {
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
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creator-less jobs fail closed (queue is not a trust boundary)", async () => {
    const job = await ctx.jobs.create({
      vmId: null,
      request: { name: "ghost-vm" },
      createdByUserId: null,
    });
    const outcome = await runProvisioningJob(ctx, job.id, 0);
    expect(outcome).toBe("FAILED");
    const { status, detail } = await lastFailureReason(ctx, job.id);
    expect(status).toBe("FAILED");
    expect(detail).toBe("authorization-recheck");
  });

  it("creator stripped of vm.create between queueing and execution is rejected", async () => {
    const user = await ctx.users.create({
      username: "revoked-creator",
      passwordHash: await hashPassword("Revoked-Password-1!"),
      roles: ["USER"],
    });
    await ctx.db.query("INSERT INTO user_permissions (user_id, permission) VALUES ($1, 'vm.create')", [user.id]);
    const job = await ctx.jobs.create({
      vmId: null,
      request: { name: "revoked-vm" },
      createdByUserId: user.id,
    });
    // Revocation lands after enqueue, before the worker picks the job up.
    await ctx.db.query("DELETE FROM user_permissions WHERE user_id = $1 AND permission = 'vm.create'", [user.id]);
    const outcome = await runProvisioningJob(ctx, job.id, 0);
    expect(outcome).toBe("FAILED");
    const { detail } = await lastFailureReason(ctx, job.id);
    expect(detail).toBe("authorization-recheck");
  });

  it("creator stripped of vm.edit cannot confer delegated access at execution", async () => {
    const creator = await ctx.users.create({
      username: "demoted-delegator",
      passwordHash: await hashPassword("Demoted-Password-1!"),
      roles: ["USER"],
    });
    const target = await ctx.users.create({
      username: "delegate-target",
      passwordHash: await hashPassword("Target-Password-1!"),
      roles: ["USER"],
    });
    await ctx.db.query("INSERT INTO user_permissions (user_id, permission) VALUES ($1, 'vm.create')", [creator.id]);
    await ctx.db.query("INSERT INTO user_permissions (user_id, permission) VALUES ($1, 'vm.edit')", [creator.id]);
    const job = await ctx.jobs.create({
      vmId: null,
      request: { name: "delegated-vm", assignToUserIds: [target.id] },
      createdByUserId: creator.id,
    });
    await ctx.db.query("DELETE FROM user_permissions WHERE user_id = $1 AND permission = 'vm.edit'", [creator.id]);
    const outcome = await runProvisioningJob(ctx, job.id, 0);
    expect(outcome).toBe("FAILED");
    const { detail } = await lastFailureReason(ctx, job.id);
    expect(detail).toBe("authorization-recheck");
  });

  it("disabled creator is rejected even with intact grants", async () => {
    const user = await ctx.users.create({
      username: "disabled-creator",
      passwordHash: await hashPassword("Disabled-Password-1!"),
      roles: ["USER"],
    });
    await ctx.db.query("INSERT INTO user_permissions (user_id, permission) VALUES ($1, 'vm.create')", [user.id]);
    const job = await ctx.jobs.create({
      vmId: null,
      request: { name: "disabled-vm" },
      createdByUserId: user.id,
    });
    await ctx.users.setActive(user.id, false);
    const outcome = await runProvisioningJob(ctx, job.id, 0);
    expect(outcome).toBe("FAILED");
    const { detail } = await lastFailureReason(ctx, job.id);
    expect(detail).toBe("authorization-recheck");
  });

  it("authorized creator passes the recheck (fails later, elsewhere)", async () => {
    const user = await ctx.users.create({
      username: "live-creator",
      passwordHash: await hashPassword("Live-Password-1!"),
      roles: ["USER"],
    });
    await ctx.db.query("INSERT INTO user_permissions (user_id, permission) VALUES ($1, 'vm.create')", [user.id]);
    const job = await ctx.jobs.create({
      vmId: null,
      request: { name: "live-vm" },
      createdByUserId: user.id,
    });
    // No Proxmox configured: the job must get PAST authorization and fail
    // downstream — proving the recheck is not over-blocking.
    const outcome = await runProvisioningJob(ctx, job.id, 0);
    expect(outcome).toBe("FAILED");
    const { detail } = await lastFailureReason(ctx, job.id);
    expect(detail).not.toBe("authorization-recheck");
  });
});
