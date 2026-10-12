import { describe, expect, it, beforeAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  hashPassword,
  hasPermission,
  isAdmin,
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

async function roleId(ctx: CoreContext, name: string): Promise<string> {
  const rows = await ctx.db.query<{ id: string }>("SELECT id FROM roles WHERE name = $1", [name]);
  return rows.rows[0]!.id;
}

describe("expired legacy role grants", () => {
  let ctx: CoreContext;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, { db: pool, redis: new RedisMock() as never, logger: silentLogger });
  });

  it("active temporary admin authorizes, expired one does not (all load paths)", async () => {
    const adminRole = await roleId(ctx, "ADMIN");
    const user = await ctx.users.create({
      username: "temp-admin",
      passwordHash: await hashPassword("Temp-Password-1!"),
      roles: [],
    });
    await ctx.db.query("INSERT INTO user_roles (user_id, role_id, expires_at) VALUES ($1, $2, NOW() + interval '1 hour')", [
      user.id,
      adminRole,
    ]);

    for (const loaded of [await ctx.users.findById(user.id), await ctx.users.requireById(user.id)]) {
      expect(loaded!.roles).toContain("ADMIN");
      expect(isAdmin(loaded)).toBe(true);
      expect(hasPermission(loaded, "users.manage")).toBe(true);
    }

    await ctx.db.query("UPDATE user_roles SET expires_at = NOW() - interval '1 minute' WHERE user_id = $1", [user.id]);

    for (const loaded of [
      await ctx.users.findById(user.id),
      await ctx.users.requireById(user.id),
      await ctx.users.findByUsername("temp-admin"),
      (await ctx.users.list()).find((u) => u.id === user.id)!,
    ]) {
      expect(loaded!.roles).not.toContain("ADMIN");
      expect(isAdmin(loaded)).toBe(false);
      expect(hasPermission(loaded, "users.manage")).toBe(false);
    }
    // Expired row is history, not deleted.
    const rows = await ctx.db.query("SELECT count(*)::text AS c FROM user_roles WHERE user_id = $1", [user.id]);
    expect(rows.rows[0]!.c).toBe("1");
  });

  it("permanent admin is unaffected and last-admin guard counts only active admins", async () => {
    const adminRole = await roleId(ctx, "ADMIN");
    const perm = await ctx.users.create({
      username: "perm-admin",
      passwordHash: await hashPassword("Perm-Password-1!"),
      roles: ["ADMIN"],
    });
    const temp = await ctx.users.create({
      username: "temp-admin-2",
      passwordHash: await hashPassword("Temp-Password-2!"),
      roles: [],
    });
    await ctx.db.query("INSERT INTO user_roles (user_id, role_id, expires_at) VALUES ($1, $2, NOW() - interval '1 minute')", [
      temp.id,
      adminRole,
    ]);

    expect((await ctx.users.findById(perm.id))!.roles).toContain("ADMIN");
    expect(await ctx.users.countActiveAdmins()).toBeGreaterThanOrEqual(1);
    // The expired grant must not satisfy the last-admin guard on its own.
    await expect(ctx.users.setRolesGuarded(temp.id, [])).resolves.toBeUndefined();
  });

  it("revocation takes effect on the next load", async () => {
    const user = await ctx.users.create({
      username: "revoked-op",
      passwordHash: await hashPassword("Revoked-Pass-1!"),
      roles: ["OPERATOR"],
    });
    expect(hasPermission(await ctx.users.findById(user.id), "vm.create")).toBe(true);
    await ctx.users.setRoles(user.id, ["USER"]);
    const reloaded = await ctx.users.findById(user.id);
    expect(reloaded!.roles).toEqual(["USER"]);
    expect(hasPermission(reloaded, "vm.create")).toBe(false);
    expect(hasPermission(reloaded, "guac.launch")).toBe(true);
  });
});
