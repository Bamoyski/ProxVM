import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { createCore, makeLogger, hashPassword, type CoreContext, type LocalConfig } from "@proxvm/core";
import { buildApp } from "../src/app.js";
import RedisMockCtor from "ioredis-mock";

const masterKey = "d".repeat(64);

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

describe("expired admin grants (API enforcement)", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie = "";
  let aliceId = "";

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    await ctx.users.create({
      username: "admin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    const alice = await ctx.users.create({
      username: "alice",
      passwordHash: await hashPassword("User-Password-1!"),
      roles: [],
    });
    aliceId = alice.id;
    const role = await ctx.db.query<{ id: string }>("SELECT id FROM roles WHERE name = 'ADMIN'");
    await ctx.db.query("INSERT INTO user_roles (user_id, role_id, expires_at) VALUES ($1, $2, NOW() + interval '1 hour')", [
      aliceId,
      role.rows[0]!.id,
    ]);
    app = await buildApp({ setupMode: false, ctx });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "User-Password-1!" },
    });
    expect(login.statusCode).toBe(200);
    const c = login.cookies.find((x) => x.name === "proxvm_session");
    cookie = `${c?.name}=${c?.value}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("active temporary admin passes, expired temporary admin is denied", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/users", headers: { cookie } });
    expect(ok.statusCode).toBe(200);

    await ctx.db.query("UPDATE user_roles SET expires_at = NOW() - interval '1 minute' WHERE user_id = $1", [aliceId]);

    const denied = await app.inject({ method: "GET", url: "/api/users", headers: { cookie } });
    expect(denied.statusCode).toBe(403);
  });
});
