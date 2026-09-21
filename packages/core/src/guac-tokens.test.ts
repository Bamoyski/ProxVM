import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  hashPassword,
  type CoreContext,
  type LocalConfig,
} from "./index.js";

const localConfig: LocalConfig = {
  version: 1,
  app: {
    cookieSecure: true,
    sessionDurationHours: 12,
    sessionIdleTimeoutMinutes: 120,
    allowRegistrationOpen: false,
  },
  database: { host: "localhost", port: 5432, name: "proxvm", user: "u", password: "p", ssl: false },
  redis: { host: "127.0.0.1", port: 6379, db: 0 },
  secrets: {
    sessionSigningKey: "s".repeat(64),
    masterKeyId: "v1",
    masterKey: "9".repeat(64),
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

describe("guacamole session token tracking", () => {
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

  it("tracks tokens per session and revokes them with server invalidation", async () => {
    const user = await ctx.users.create({
      username: "tokholder",
      passwordHash: await hashPassword("Tokholder-Pass-1!"),
      roles: ["USER"],
    });
    const s1 = await ctx.sessions.create(user.id, { ip: null, userAgent: null });
    const s2 = await ctx.sessions.create(user.id, { ip: null, userAgent: null });

    await ctx.guac.trackSessionToken(s1.id, "guac-token-aaa");
    await ctx.guac.trackSessionToken(s2.id, "guac-token-bbb");

    // Ciphertext at rest must not contain the raw token.
    const stored = await ctx.db.query<{ token_ciphertext: string }>("SELECT token_ciphertext FROM guac_session_tokens");
    expect(stored.rows).toHaveLength(2);
    for (const row of stored.rows) {
      expect(row.token_ciphertext).not.toContain("guac-token");
    }

    const invalidated: string[] = [];
    const fakeApi = { deleteToken: async (token: string) => void invalidated.push(token) } as never;
    const revoked = await ctx.guac.revokeSessionTokens(s1.id, fakeApi);
    expect(revoked).toBe(1);
    expect(invalidated).toEqual(["guac-token-aaa"]);

    const remaining = await ctx.db.query("SELECT * FROM guac_session_tokens");
    expect(remaining.rows).toHaveLength(1);

    // Revoking one session leaves the other untouched; user-wide revocation clears it.
    const total = await ctx.guac.revokeAllUserTokens(user.id, fakeApi);
    expect(total).toBe(1);
    expect(invalidated).toEqual(["guac-token-aaa", "guac-token-bbb"]);
    const gone = await ctx.db.query("SELECT * FROM guac_session_tokens");
    expect(gone.rows).toHaveLength(0);
  });

  it("revocation still drops rows when the Guacamole API is unreachable", async () => {
    const user = await ctx.users.create({
      username: "tokholder2",
      passwordHash: await hashPassword("Tokholder-Pass-1!"),
      roles: ["USER"],
    });
    const s = await ctx.sessions.create(user.id, { ip: null, userAgent: null });
    await ctx.guac.trackSessionToken(s.id, "guac-token-ccc");
    const revoked = await ctx.guac.revokeSessionTokens(s.id, null);
    expect(revoked).toBe(0);
    const gone = await ctx.db.query("SELECT * FROM guac_session_tokens WHERE proxvm_session_id = $1", [s.id]);
    expect(gone.rows).toHaveLength(0);
  });
});
