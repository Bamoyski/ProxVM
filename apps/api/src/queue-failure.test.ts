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

const masterKey = "9".repeat(64);

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

describe("queue-outage job handling", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let operator: Session;
  let templateId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });

    await ctx.settings.set("proxmox.url", "https://proxmox.example:8006");
    await ctx.settings.set("proxmox.token_id", "root@pam!test");
    await ctx.settings.set("proxmox.token_secret", "test-secret-value");
    await ctx.settings.set("proxmox.default_storage", "local-lvm");

    const template = await ctx.templates.register({
      name: "debian",
      node: "node1",
      proxmoxVmid: 9200,
      osType: "linux",
      provisioningMethod: "cloud-init",
      cloudInitSupport: true,
      guestAgentRequired: true,
      defaultCpu: 2,
      defaultRamMb: 2048,
      defaultDiskGb: 20,
      supportedProtocols: ["ssh"],
    });
    templateId = template.id;

    await ctx.users.create({
      username: "op",
      passwordHash: await hashPassword("Operator-Pass-1!"),
      roles: ["OPERATOR"],
    });

    app = await buildApp({ setupMode: false, ctx });
    // NOTE: no queue attached -> getQueue() throws 503, simulating Redis/queue outage.
    operator = await login(app, "op", "Operator-Pass-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  it("failed provision enqueue marks the job FAILED instead of leaving it PENDING forever", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf },
      payload: { name: "orphan-01", templateId, password: "Queue-Failure-1!" },
    });
    expect(res.statusCode).toBe(503);

    const jobs = await ctx.jobs.list({ limit: 10 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("FAILED");
    expect(jobs[0]!.error).toMatch(/queue/i);

    const audit = await ctx.audit.list({ limit: 50 });
    expect(audit.filter((a) => a.jobId === jobs[0]!.id).map((a) => a.event)).toContain(
      "PROVISIONING_FAILED",
    );
  });

  it("failed retry enqueue restores the job to FAILED instead of leaving it PENDING", async () => {
    const job = await ctx.jobs.create({
      vmId: null,
      request: { name: "retry-01" },
      createdByUserId: null,
    });
    await ctx.jobs.updateStatus(job.id, "FAILED", "earlier failure");

    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/retry`,
      headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf },
      payload: {},
    });
    // attempt counter uses redis mock (works); enqueue throws 503
    expect(res.statusCode).toBe(503);

    const after = await ctx.jobs.get(job.id);
    expect(after!.status).toBe("FAILED");
  });
});
