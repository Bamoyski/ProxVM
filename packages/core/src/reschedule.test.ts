import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  handleProvisioningOutcome,
  MAX_WAIT_ATTEMPTS,
  WAIT_RECHECK_DELAY_MS,
  type CoreContext,
  type LocalConfig,
} from "./index.js";

const masterKey = "6".repeat(64);

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

describe("worker reschedule outcome handling", () => {
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

  function deps() {
    return { jobs: ctx.jobs, audit: ctx.audit, logger: silentLogger };
  }

  it("passes non-reschedule outcomes through untouched", async () => {
    const queue = { add: async () => undefined };
    for (const outcome of ["COMPLETED", "FAILED", "SKIPPED"] as const) {
      const job = await ctx.jobs.create({ vmId: null, request: {}, createdByUserId: null });
      const result = await handleProvisioningOutcome(deps(), queue, job.id, 0, outcome);
      expect(result).toBe(outcome);
    }
  });

  it("re-queues with the next attempt and job-scoped id", async () => {
    const added: Array<{ name: string; data: unknown; opts: unknown }> = [];
    const queue = {
      add: async (name: string, data: unknown, opts: unknown) => {
        added.push({ name, data, opts });
        return { id: "bull-1" };
      },
    };
    const job = await ctx.jobs.create({ vmId: null, request: {}, createdByUserId: null });
    const result = await handleProvisioningOutcome(deps(), queue, job.id, 3, "RESCHEDULE");
    expect(result).toBe("RESCHEDULE");
    expect(added).toHaveLength(1);
    expect(added[0]).toEqual({
      name: "provision",
      data: { jobDbId: job.id, attempt: 4 },
      opts: { delay: WAIT_RECHECK_DELAY_MS, jobId: `db-${job.id}-a4` },
    });
    // DB job untouched: a future attempt will still pick it up.
    expect((await ctx.jobs.get(job.id))!.status).toBe("PENDING");
  });

  it("reschedule-limit failure is terminal and audited without touching the queue", async () => {
    const queue = {
      add: async (): Promise<never> => {
        throw new Error("must not be called past the reschedule limit");
      },
    };
    const job = await ctx.jobs.create({ vmId: null, request: {}, createdByUserId: null });
    const result = await handleProvisioningOutcome(deps(), queue, job.id, MAX_WAIT_ATTEMPTS - 1, "RESCHEDULE");
    expect(result).toBe("FAILED");
    const after = await ctx.jobs.get(job.id);
    expect(after!.status).toBe("FAILED");
    expect(after!.error).toMatch(/never became reachable/);
    const audit = await ctx.audit.list({ limit: 50 });
    const entry = audit.find((a) => a.jobId === job.id && a.event === "PROVISIONING_FAILED");
    expect(entry).toBeTruthy();
  });

  it("re-queue failure compensates to FAILED (no orphan non-terminal job) and rethrows", async () => {
    const queue = {
      add: async (): Promise<never> => {
        throw new Error("Redis connection lost");
      },
    };
    const job = await ctx.jobs.create({ vmId: null, request: {}, createdByUserId: null });
    await expect(handleProvisioningOutcome(deps(), queue, job.id, 2, "RESCHEDULE")).rejects.toThrow(
      "Redis connection lost",
    );
    const after = await ctx.jobs.get(job.id);
    expect(after!.status).toBe("FAILED");
    expect(after!.error).toMatch(/reschedule/i);
    const audit = await ctx.audit.list({ limit: 50 });
    const entry = audit.find((a) => a.jobId === job.id && a.event === "PROVISIONING_FAILED");
    expect(entry).toBeTruthy();
    expect((entry!.detail as Record<string, unknown>).reason).toBe("reschedule-queue-failure");
  });
});
