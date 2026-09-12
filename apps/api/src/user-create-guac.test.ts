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

const masterKey = "5".repeat(64);

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

async function loginAsAdmin(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: "Admin-Password-1!" },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "proxvm_session");
  return {
    cookie: `${cookie?.name}=${cookie?.value}`,
    csrf: (res.json() as { csrfToken: string }).csrfToken,
  };
}

describe("user creation with Guacamole unavailable", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: { cookie: string; csrf: string };

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    // NOTE: no Guacamole settings configured -> getGuacDb() throws.
    await ctx.users.create({
      username: "admin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    app = await buildApp({ setupMode: false, ctx });
    admin = await loginAsAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it("creating a user succeeds and defers the Guacamole account (launch self-heals)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { username: "bob", password: "Bob-Password-1!", role: "USER" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: { id: string; username: string } };
    expect(body.user.username).toBe("bob");

    // The user really exists Exactly once (a retry must not hit a 409 ghost).
    const again = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { username: "bob", password: "Bob-Password-1!", role: "USER" },
    });
    expect(again.statusCode).toBe(409);

    const audit = await ctx.audit.list({ limit: 50 });
    const created = audit.find(
      (a) => a.event === "USER_CREATED" && (a.detail as Record<string, unknown> | null)?.username === "bob",
    );
    expect(created).toBeTruthy();
    expect((created!.detail as Record<string, unknown>).guacSynced).toBe(false);
  });
});
