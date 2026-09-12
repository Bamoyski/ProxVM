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

const masterKey = "8".repeat(64);

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

interface Session {
  cookie: string;
  csrf: string;
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<Session> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "proxvm_session");
  return {
    cookie: `${cookie?.name}=${cookie?.value}`,
    csrf: (res.json() as { csrfToken: string }).csrfToken,
  };
}

describe("malformed resource IDs", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;

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
    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  it("malformed UUIDs return 404, never 500", async () => {
    const gets = [
      "/api/vms/not-a-uuid",
      "/api/vms/not-a-uuid/access",
      "/api/users/not-a-uuid",
      "/api/jobs/not-a-uuid",
      "/api/templates/not-a-uuid",
    ];
    for (const url of gets) {
      const res = await app.inject({ method: "GET", url, headers: { cookie: admin.cookie } });
      expect(res.statusCode, url).toBe(404);
    }
    const launch = await app.inject({
      method: "POST",
      url: "/api/vms/not-a-uuid/guacamole/launch",
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: {},
    });
    expect(launch.statusCode).toBe(404);
  });

  it("well-formed but unknown UUIDs still return 404", async () => {
    const missing = "11111111-1111-4111-8111-111111111111";
    const res = await app.inject({
      method: "GET",
      url: `/api/vms/${missing}`,
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
