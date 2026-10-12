import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  checkCsrf,
  createCore,
  deriveCsrfKey,
  deriveCsrfToken,
  hashSid,
  type CoreContext,
  type LocalConfig,
} from "./index.js";

const masterKey = "a".repeat(64);

const silentLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as never;

function config(sessionSigningKey: string): LocalConfig {
  return {
    version: 1,
    app: {
      cookieSecure: false,
      sessionDurationHours: 12,
      sessionIdleTimeoutMinutes: 120,
      allowRegistrationOpen: false,
    },
    database: { host: "localhost", port: 5432, name: "proxvm", user: "u", password: "p", ssl: false },
    redis: { host: "127.0.0.1", port: 6379, db: 0 },
    secrets: { sessionSigningKey, masterKeyId: "v1", masterKey },
  };
}

function makeCtx(sessionSigningKey: string): Promise<CoreContext> {
  const mem = newDb();
  const { Pool: MemPool } = mem.adapters.createPg();
  const pool = new MemPool() as unknown as Pool;
  return createCore(config(sessionSigningKey), {
    db: pool,
    redis: new RedisMock() as never,
    logger: silentLogger,
  });
}

describe("csrf token derivation (pure)", () => {
  it("is deterministic for the same key and session id", () => {
    const key = deriveCsrfKey("s".repeat(64));
    expect(deriveCsrfToken("session-abc", key)).toBe(deriveCsrfToken("session-abc", key));
    expect(deriveCsrfToken("session-abc", key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs per session id", () => {
    const key = deriveCsrfKey("s".repeat(64));
    expect(deriveCsrfToken("a", key)).not.toBe(deriveCsrfToken("b", key));
  });

  it("changes when the signing key rotates", () => {
    const k1 = deriveCsrfKey("s".repeat(64));
    const k2 = deriveCsrfKey("t".repeat(64));
    expect(deriveCsrfToken("session-abc", k1)).not.toBe(deriveCsrfToken("session-abc", k2));
  });

  it("applies domain separation (subkey is not the raw signing material)", () => {
    const signingKey = "s".repeat(64);
    const key = deriveCsrfKey(signingKey);
    expect(key.length).toBe(32);
    expect(key.toString("hex")).not.toBe(signingKey);
    // A token computed without the HKDF step must not match the derived one.
    const naive = deriveCsrfToken("sid", Buffer.from(signingKey, "utf8"));
    expect(deriveCsrfToken("sid", key)).not.toBe(naive);
  });
});

describe("checkCsrf comparisons", () => {
  it("accepts an exact match and rejects mismatches/missing values", () => {
    const key = deriveCsrfKey("s".repeat(64));
    const token = deriveCsrfToken("sid", key);
    expect(() => checkCsrf(token, token)).not.toThrow();
    expect(() => checkCsrf(token, undefined)).toThrow(/missing/);
    expect(() => checkCsrf(token, token.replace(/.$/, "0"))).toThrow(/mismatch/);
    expect(() => checkCsrf(token, "short")).toThrow(/mismatch/);
  });
});

describe("sessions service CSRF integration (pg-mem)", () => {
  let ctx: CoreContext;
  let userId: string;

  beforeAll(async () => {
    ctx = await makeCtx("s".repeat(64));
    const user = await ctx.users.create({
      username: "csrf-user",
      passwordHash: "x",
      roles: ["USER"],
    });
    userId = user.id;
  });

  afterAll(async () => {
    await ctx.db.end().catch(() => undefined);
  });

  it("stores no csrf token at rest (column removed)", async () => {
    const created = await ctx.sessions.create(userId, { ip: "127.0.0.1", userAgent: "test" });
    expect(created.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    const rows = await ctx.db.query<Record<string, unknown>>("SELECT * FROM sessions");
    const row = rows.rows.find((r) => r.sid_hash === hashSid(created.sid));
    expect(row).toBeDefined();
    expect("csrf_token" in (row as object)).toBe(false);
    expect(JSON.stringify(row)).not.toContain(created.sid);
  });

  it("returns the same deterministic token on create, findBySid, and validate", async () => {
    const created = await ctx.sessions.create(userId, { ip: null, userAgent: null });
    const bySid = await ctx.sessions.findBySid(created.sid);
    const validated = await ctx.sessions.validate(created.sid);
    expect(bySid?.csrfToken).toBe(created.csrfToken);
    expect(validated?.csrfToken).toBe(created.csrfToken);
  });

  it("produces a distinct token per session and is stable under concurrent reads", async () => {
    const [s1, s2] = await Promise.all([
      ctx.sessions.create(userId, { ip: null, userAgent: null }),
      ctx.sessions.create(userId, { ip: null, userAgent: null }),
    ]);
    expect(s1.csrfToken).not.toBe(s2.csrfToken);

    const reads = await Promise.all(
      Array.from({ length: 25 }, () => ctx.sessions.findBySid(s1.sid)),
    );
    for (const r of reads) expect(r?.csrfToken).toBe(s1.csrfToken);
  });

  it("a revoked session no longer validates", async () => {
    const created = await ctx.sessions.create(userId, { ip: null, userAgent: null });
    expect(await ctx.sessions.validate(created.sid)).not.toBeNull();
    await ctx.sessions.revoke(created.id);
    expect(await ctx.sessions.validate(created.sid)).toBeNull();
  });

  it("revokeAllForUser invalidates every session", async () => {
    const a = await ctx.sessions.create(userId, { ip: null, userAgent: null });
    const b = await ctx.sessions.create(userId, { ip: null, userAgent: null });
    await ctx.sessions.revokeAllForUser(userId);
    expect(await ctx.sessions.validate(a.sid)).toBeNull();
    expect(await ctx.sessions.validate(b.sid)).toBeNull();
  });

  it("a signing-key change yields different tokens for the same session id", async () => {
    const other = await makeCtx("t".repeat(64));
    try {
      const created = await ctx.sessions.create(userId, { ip: null, userAgent: null });
      const otherUser = await other.users.create({ username: "u2", passwordHash: "x", roles: ["USER"] });
      const otherSession = await other.sessions.create(otherUser.id, { ip: null, userAgent: null });
      expect(otherSession.csrfToken).not.toBe(created.csrfToken);
      const keyA = deriveCsrfKey("s".repeat(64));
      const keyB = deriveCsrfKey("t".repeat(64));
      expect(deriveCsrfToken(created.sid, keyA)).not.toBe(deriveCsrfToken(created.sid, keyB));
    } finally {
      await other.db.end().catch(() => undefined);
    }
  });
});
