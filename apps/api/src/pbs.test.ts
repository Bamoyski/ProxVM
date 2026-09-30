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
    masterKey: "e".repeat(64),
  },
};

describe("PBS status baseline", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminCookie: string;
  let adminCsrf: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    const ctx: CoreContext = await createCore(localConfig, {
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
      username: "bob",
      passwordHash: await hashPassword("Bob-Password-1!"),
      roles: ["USER"],
    });
    app = await buildApp({ setupMode: false, ctx });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "Admin-Password-1!" },
    });
    const cookie = login.cookies.find((c) => c.name === "proxvm_session");
    adminCookie = `${cookie?.name}=${cookie?.value}`;
    adminCsrf = (login.json() as { csrfToken: string }).csrfToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports unconfigured PBS without touching the network", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/pbs/status",
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false, reachable: false, version: null });
  });
});
