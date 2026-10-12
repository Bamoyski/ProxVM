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

  it("a new launch revokes the previous session token (single live token)", async () => {
    const user = await ctx.users.create({
      username: "tokholder3",
      passwordHash: await hashPassword("Tokholder-Pass-1!"),
      roles: ["USER"],
    });
    const vm = await ctx.vms.create({ vmid: 801, node: "n1", name: "tok-vm", status: "running" });
    const s = await ctx.sessions.create(user.id, { ip: null, userAgent: null });
    await ctx.db.query(
      "INSERT INTO guacamole_users (id, user_id, guac_username, password_ciphertext, key_id, status) VALUES ($1, $2, $3, $4, 'v1', 'ACTIVE')",
      ["11111111-1111-4111-8111-111111111111", user.id, "px_tokholder3", ctx.encrypt("Guac-Pass-1!")],
    );
    await ctx.db.query(
      "INSERT INTO guacamole_connections (id, vm_id, protocol, hostname, port, username, password_ciphertext, key_id, guac_connection_name, guac_identifier, status) VALUES ($1, $2, 'rdp', '10.0.0.9', 3389, 'victim', $3, 'v1', 'proxvm-tok-vm', 'ident-0', 'ACTIVE')",
      ["22222222-2222-4222-8222-222222222222", vm.id, ctx.encrypt("Guest-Pass-1!")],
    );
    let n = 0;
    const deleted: string[] = [];
    const fakeApi = {
      requestToken: async () => {
        n += 1;
        return { authToken: `tok-${n}`, username: "px_tokholder3", dataSource: "postgresql", availableDataSources: [] };
      },
      findConnectionIdentifier: async () => "ident-1",
      deleteToken: async (token: string) => void deleted.push(token),
    } as never;

    const r1 = await ctx.guac.launch(vm.id, user.id, fakeApi, "http://guac:8080/guacamole", null, "rdp", {
      trackSessionId: s.id,
    });
    expect(r1.mode).toBe("direct");
    expect(r1.url).toContain("tok-1");
    const r2 = await ctx.guac.launch(vm.id, user.id, fakeApi, "http://guac:8080/guacamole", null, "rdp", {
      trackSessionId: s.id,
    });
    expect(r2.mode).toBe("direct");
    // The first token was invalidated server-side when the second launched.
    expect(deleted).toEqual(["tok-1"]);
    const rows = await ctx.db.query<{ token_ciphertext: string }>(
      "SELECT token_ciphertext FROM guac_session_tokens WHERE proxvm_session_id = $1",
      [s.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(ctx.decrypt(rows.rows[0]!.token_ciphertext)).toBe("tok-2");
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
