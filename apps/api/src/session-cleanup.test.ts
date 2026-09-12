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
import { startSessionCleanup } from "../src/app.js";
import RedisMockCtor from "ioredis-mock";

const masterKey = "4".repeat(64);

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

describe("session cleanup", () => {
  let ctx: CoreContext;
  let userId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    const user = await ctx.users.create({
      username: "alice",
      passwordHash: await hashPassword("Alice-Password-1!"),
      roles: ["USER"],
    });
    userId = user.id;
  });

  afterAll(async () => {
    await (ctx.db as Pool).end().catch(() => undefined);
  });

  async function makeSession(): Promise<string> {
    const s = await ctx.sessions.create(userId, { ip: null, userAgent: null });
    return s.id;
  }

  async function ageSession(id: string, sql: string): Promise<void> {
    await ctx.db.query(`UPDATE sessions SET ${sql} WHERE id = $1`, [id]);
  }

  async function sessionExists(id: string): Promise<boolean> {
    const r = await ctx.db.query("SELECT id FROM sessions WHERE id = $1", [id]);
    return r.rows.length > 0;
  }

  it("prunes only long-expired or long-revoked sessions", async () => {
    const fresh = await makeSession();
    const expiredOld = await makeSession();
    await ageSession(expiredOld, "expires_at = NOW() - interval '2 days'");
    const revokedOld = await makeSession();
    await ageSession(revokedOld, "revoked_at = NOW() - interval '2 days'");
    const expiredRecent = await makeSession();
    await ageSession(expiredRecent, "expires_at = NOW() - interval '1 hour'");

    await ctx.sessions.cleanup();

    expect(await sessionExists(fresh)).toBe(true);
    expect(await sessionExists(expiredRecent)).toBe(true);
    expect(await sessionExists(expiredOld)).toBe(false);
    expect(await sessionExists(revokedOld)).toBe(false);
  });

  it("the scheduled cleanup wiring actually prunes without a manual call", async () => {
    const stale = await makeSession();
    await ageSession(stale, "expires_at = NOW() - interval '2 days'");
    // Minimal app surface: only the onClose hook registration is used.
    startSessionCleanup({ addHook: () => undefined } as never, ctx, 20);
    for (let i = 0; i < 50 && (await sessionExists(stale)); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await sessionExists(stale)).toBe(false);
  });
});
