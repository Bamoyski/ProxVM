import { describe, expect, it, beforeAll } from "vitest";
import { newDb } from "pg-mem";
import RedisMock from "ioredis-mock";
import { Pool } from "pg";
import { createCore, type CoreContext, type LocalConfig } from "./index.js";

const masterKey = "b".repeat(64);

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

describe("initial-admin protection (pg-mem)", () => {
  let ctx: CoreContext;
  let firstAdminId: string;
  let secondAdminId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMock() as never,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    });

    const first = await ctx.users.create({
      username: "root-admin",
      passwordHash: "x",
      roles: ["ADMIN"],
    });
    await ctx.users.markInitialAdmin(first.id);
    firstAdminId = first.id;

    const second = await ctx.users.create({
      username: "second-admin",
      passwordHash: "x",
      roles: ["ADMIN"],
    });
    secondAdminId = second.id;
  });

  it("first admin cannot be demoted", async () => {
    await expect(ctx.users.setRolesGuarded(firstAdminId, ["USER"])).rejects.toThrow(/initial administrator/i);
  });

  it("first admin cannot be deleted, even with other admins present", async () => {
    await expect(ctx.users.deleteGuarded(firstAdminId)).rejects.toThrow(/initial administrator.*cannot be deleted/i);
  });

  it("secondary admin cannot change the first admin's role", async () => {
    await expect(ctx.users.setRolesGuarded(firstAdminId, ["OPERATOR"])).rejects.toThrow(/initial administrator/i);
    const first = await ctx.users.findById(firstAdminId);
    expect(first?.roles).toEqual(["ADMIN"]);
  });

  it("an admin cannot demote themselves if it would leave zero admins", async () => {
    const only = await ctx.users.create({ username: "only-admin", passwordHash: "x", roles: ["ADMIN"] });
    await ctx.users.deleteGuarded(secondAdminId);
    await ctx.users.setActive(firstAdminId, false);
    try {
      await expect(ctx.users.setRolesGuarded(only.id, ["USER"])).rejects.toThrow(/only active administrator/i);
      await expect(ctx.users.deleteGuarded(only.id)).rejects.toThrow(/only active administrator/i);
      const check = await ctx.users.findById(only.id);
      expect(check?.roles).toEqual(["ADMIN"]);
    } finally {
      await ctx.users.setActive(firstAdminId, true);
    }
    onlyAdminId = only.id;
  });

  let onlyAdminId: string;

  it("another admin can still be created/promoted normally", async () => {
    const promoted = await ctx.users.create({ username: "new-admin", passwordHash: "x", roles: ["USER"] });
    await ctx.users.setRolesGuarded(promoted.id, ["ADMIN"]);
    const now = await ctx.users.findById(promoted.id);
    expect(now?.roles).toEqual(["ADMIN"]);

    await ctx.users.setRolesGuarded(onlyAdminId, ["USER"]);
    const demoted = await ctx.users.findById(onlyAdminId);
    expect(demoted?.roles).toEqual(["USER"]);
  });
});
