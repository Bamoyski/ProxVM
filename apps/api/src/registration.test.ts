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
    masterKey: "f".repeat(64),
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

describe("registration with admin approval", () => {
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

  const authA = () => ({ cookie: admin.cookie, "x-csrf-token": admin.csrf });

  it("accepts valid requests and rejects weak passwords", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "newbie", password: "Newbie-Password-1!" },
    });
    expect(ok.statusCode).toBe(201);

    const weak = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "weakling", password: "short" },
    });
    expect(weak.statusCode).toBe(400);

    const dup = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "newbie", password: "Other-Password-1!" },
    });
    expect(dup.statusCode).toBe(409);

    const taken = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "admin", password: "Admin-Password-1!" },
    });
    expect(taken.statusCode).toBe(409);
  });

  it("approval creates a loginable account; rejection blocks it", async () => {
    const queue = await app.inject({ method: "GET", url: "/api/registration-requests?status=pending", headers: authA() });
    expect(queue.statusCode).toBe(200);
    const pending = (queue.json() as { requests: Array<{ id: string; username: string }> }).requests;
    expect(pending.map((r) => r.username)).toContain("newbie");
    const reqId = pending.find((r) => r.username === "newbie")!.id;

    const approve = await app.inject({
      method: "POST",
      url: `/api/registration-requests/${reqId}/approve`,
      headers: authA(),
      payload: { role: "USER" },
    });
    expect(approve.statusCode).toBe(200);

    // Approved user can log in immediately.
    const session = await login(app, "newbie", "Newbie-Password-1!");
    expect(session.cookie).toContain("proxvm_session=");

    // Deciding twice is a conflict, not a second account.
    const again = await app.inject({
      method: "POST",
      url: `/api/registration-requests/${reqId}/approve`,
      headers: authA(),
      payload: {},
    });
    expect(again.statusCode).toBe(409);

    const second = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "second", password: "Second-Password-1!" },
    });
    expect(second.statusCode).toBe(201);
    const secondId = (second.json() as { id: string }).id;
    const reject = await app.inject({
      method: "POST",
      url: `/api/registration-requests/${secondId}/reject`,
      headers: authA(),
    });
    expect(reject.statusCode).toBe(200);
    const noLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "second", password: "Second-Password-1!" },
    });
    expect(noLogin.statusCode).toBe(401);
  });

  it("non-admins cannot touch the queue", async () => {
    const session = await login(app, "newbie", "Newbie-Password-1!");
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
    const list = await app.inject({ method: "GET", url: "/api/registration-requests", headers });
    expect(list.statusCode).toBe(403);
    const approve = await app.inject({
      method: "POST",
      url: "/api/registration-requests/00000000-0000-0000-0000-000000000000/approve",
      headers,
      payload: {},
    });
    expect(approve.statusCode).toBe(403);
  });
});
