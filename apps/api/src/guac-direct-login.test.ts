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

function stubGuacDb() {
  const passwords = new Map<string, string>();
  return {
    passwords,
    async createUser(input: { username: string; password: string }): Promise<number> {
      if (!passwords.has(input.username)) passwords.set(input.username, input.password);
      return 1;
    },
    async setUserPassword(username: string, password: string): Promise<void> {
      if (!passwords.has(username)) throw new Error("no such user");
      passwords.set(username, password);
    },
    async grantRootGroupRead(): Promise<void> {},
  };
}

describe("guacamole direct-login endpoints", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminCookie: string;
  let adminCsrf: string;
  let userCookie: string;
  let userCsrf: string;
  let viennaId: string;

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
    await ctx.users.create({
      username: "plain",
      passwordHash: await hashPassword("Plain-Password-1!"),
      roles: ["USER"],
    });
    const vienna = await ctx.users.create({
      username: "vienna",
      passwordHash: await hashPassword("Vienna-Password-1!"),
      roles: ["USER"],
    });
    viennaId = vienna.id;
    // Route calls ctx.getGuacDb(): stub the Guacamole database.
    const guacDb = stubGuacDb();
    (ctx as unknown as Record<string, unknown>).getGuacDb = async () => guacDb;
    app = await buildApp({ setupMode: false, ctx });
    const login = async (username: string, password: string): Promise<{ cookie: string; csrf: string }> => {
      const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
      expect(res.statusCode).toBe(200);
      const cookie = res.cookies.find((c) => c.name === "proxvm_session");
      return { cookie: `${cookie?.name}=${cookie?.value}`, csrf: (res.json() as { csrfToken: string }).csrfToken };
    };
    ({ cookie: adminCookie, csrf: adminCsrf } = await login("admin", "Admin-Password-1!"));
    ({ cookie: userCookie, csrf: userCsrf } = await login("plain", "Plain-Password-1!"));
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => ({ cookie: adminCookie, "x-csrf-token": adminCsrf });
  const userAuth = () => ({ cookie: userCookie, "x-csrf-token": userCsrf });

  it("rejects non-admin callers", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/guacamole/users/${viennaId}/direct-login`,
      headers: userAuth(),
      payload: { password: "Vienna-Direct-1!" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects weak passwords and unknown users", async () => {
    const weak = await app.inject({
      method: "POST",
      url: `/api/guacamole/users/${viennaId}/direct-login`,
      headers: auth(),
      payload: { password: "short" },
    });
    expect(weak.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: "/api/guacamole/users/00000000-0000-0000-0000-000000000000/direct-login",
      headers: auth(),
      payload: { password: "Vienna-Direct-1!" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("enables, reports status, audits, notifies, then disables", async () => {
    const put = await app.inject({
      method: "POST",
      url: `/api/guacamole/users/${viennaId}/direct-login`,
      headers: auth(),
      payload: { password: "Vienna-Direct-1!" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json() as object).toMatchObject({ ok: true, guacUsername: "px_vienna" });

    const status = await app.inject({
      method: "GET",
      url: `/api/guacamole/users/${viennaId}/direct-login`,
      headers: { cookie: adminCookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json() as object).toMatchObject({
      username: "vienna",
      guacUsername: "px_vienna",
      directLoginEnabled: true,
    });
    // Password value never leaks through the status surface.
    expect(JSON.stringify(status.json())).not.toContain("Vienna-Direct-1!");

    const audit = await ctx.db.query("SELECT event FROM audit_logs WHERE event LIKE 'GUAC_DIRECT_LOGIN%' ORDER BY created_at");
    expect(audit.rows.map((r) => r.event)).toContain("GUAC_DIRECT_LOGIN_ENABLED");
    const bell = await ctx.db.query("SELECT title FROM notifications WHERE kind = 'user' AND title LIKE 'Direct Guacamole login enabled%'");
    expect(bell.rows).toHaveLength(1);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/guacamole/users/${viennaId}/direct-login`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(200);
    const status2 = await app.inject({
      method: "GET",
      url: `/api/guacamole/users/${viennaId}/direct-login`,
      headers: { cookie: adminCookie },
    });
    expect((status2.json() as { directLoginEnabled: boolean }).directLoginEnabled).toBe(false);
    const audit2 = await ctx.db.query("SELECT event FROM audit_logs WHERE event = 'GUAC_DIRECT_LOGIN_DISABLED'");
    expect(audit2.rows).toHaveLength(1);
  });
});
