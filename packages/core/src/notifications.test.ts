import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  hashPassword,
  notify,
  listNotifications,
  unreadNotificationCount,
  markNotificationsRead,
  type CoreContext,
  type LocalConfig,
} from "./index.js";

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

describe("notifications service", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;
  let aliceId: string;

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
    const alice = await ctx.users.create({
      username: "notify-alice",
      passwordHash: await hashPassword("Alice-Password-1!"),
      roles: ["USER"],
    });
    aliceId = alice.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("validates audience, kind, and title", async () => {
    await expect(notify(ctx.db, { audience: "nope", kind: "ticket", title: "x" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(notify(ctx.db, { audience: "admins", kind: "bogus", title: "x" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(notify(ctx.db, { audience: "admins", kind: "ticket", title: "   " })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    const ok = await notify(ctx.db, { audience: "admins", kind: "ticket", title: "Hello", body: "b".repeat(5000) });
    expect(ok.title).toBe("Hello");
    expect(ok.body!.length).toBeLessThanOrEqual(2000);
    await ctx.db.query("DELETE FROM notifications");
  });

  it("scopes listing and counts by viewer (admin vs user)", async () => {
    await notify(ctx.db, [
      { audience: "admins", kind: "ticket", title: "For admins" },
      { audience: aliceId, kind: "backup", title: "For alice" },
    ]);
    const adminView = { userId: "some-admin", isAdmin: true };
    const aliceView = { userId: aliceId, isAdmin: false };
    // Admins see the admin queue plus rows addressed to them personally —
    // not other users' personal rows.
    expect((await listNotifications(ctx.db, adminView)).map((n) => n.title)).toEqual(["For admins"]);
    expect(await unreadNotificationCount(ctx.db, adminView)).toBe(1);
    expect((await listNotifications(ctx.db, aliceView)).map((n) => n.title)).toEqual(["For alice"]);
    expect(await unreadNotificationCount(ctx.db, aliceView)).toBe(1);
    await ctx.db.query("DELETE FROM notifications");
  });

  it("mark-read cannot clear another viewer's rows", async () => {
    const [adminRow] = await notify(ctx.db, [
      { audience: "admins", kind: "threat", title: "Admins only" },
      { audience: aliceId, kind: "user", title: "Alice only" },
    ]);
    // Alice tries to clear everything including the admin row.
    expect(await markNotificationsRead(ctx.db, { userId: aliceId, isAdmin: false }, { all: true })).toBe(1);
    expect(await unreadNotificationCount(ctx.db, { userId: aliceId, isAdmin: false })).toBe(0);
    expect(await unreadNotificationCount(ctx.db, { userId: "some-admin", isAdmin: true })).toBe(1);
    // Alice cannot clear the admin row by id either.
    expect(await markNotificationsRead(ctx.db, { userId: aliceId, isAdmin: false }, { ids: [adminRow!.id] })).toBe(0);
    // Malformed ids are ignored, never error.
    expect(await markNotificationsRead(ctx.db, { userId: aliceId, isAdmin: false }, { ids: ["not-a-uuid"] })).toBe(0);
    await ctx.db.query("DELETE FROM notifications");
  });

  it("prunes ancient read rows on list", async () => {
    const row = await notify(ctx.db, { audience: "admins", kind: "system", title: "Old" });
    await ctx.db.query("UPDATE notifications SET read_at = NOW() - interval '100 days' WHERE id = $1", [row.id]);
    await listNotifications(ctx.db, { userId: "some-admin", isAdmin: true });
    const remaining = await ctx.db.query("SELECT count(*)::text AS c FROM notifications WHERE id = $1", [row.id]);
    expect(remaining.rows[0]?.c).toBe("0");
  });
});
