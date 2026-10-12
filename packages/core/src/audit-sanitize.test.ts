import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import { createCore, type CoreContext, type LocalConfig } from "./index.js";

const masterKey = "h".repeat(64);

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

describe("audit detail sanitization (recursive)", () => {
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

  it("redacts nested secrets and leaves benign values intact", async () => {
    await ctx.audit.record({
      event: "SETTINGS_CHANGED",
      actorUsername: "admin",
      detail: {
        section: "proxmox",
        config: { nested: { tokenSecret: "s3cret", url: "https://x" } },
        items: [{ password: "p", name: "ok" }],
        count: 3,
      },
    });
    const rows = await ctx.audit.list({ limit: 5 });
    const detail = rows[0]!.detail as Record<string, unknown>;
    expect((detail.config as Record<string, unknown>).nested).toMatchObject({
      tokenSecret: "[REDACTED]",
      url: "https://x",
    });
    expect((detail.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      password: "[REDACTED]",
      name: "ok",
    });
    expect(detail.count).toBe(3);
    expect(JSON.stringify(detail)).not.toContain("s3cret");
  });
});
