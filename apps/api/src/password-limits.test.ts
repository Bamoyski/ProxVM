import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { createCore, makeLogger, hashPassword, type CoreContext, type LocalConfig } from "@proxvm/core";
import { buildApp } from "../src/app.js";
import RedisMockCtor from "ioredis-mock";

const masterKey = "e".repeat(64);

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

// Valid except length: lowercase + upper + digit + symbol.
const pw = (len: number): string => `Aa1!${"x".repeat(Math.max(0, len - 4))}`;

describe("password length policy (DoS bound)", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminCookie = "";
  let adminCsrf = "";
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
      roles: ["USER"],
    });
    aliceId = alice.id;
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

  const auth = () => ({ cookie: adminCookie, "x-csrf-token": adminCsrf });

  it("rejects oversized passwords on every password-setting endpoint", async () => {
    const big = pw(129);

    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "biguser", password: big },
    });
    expect(register.statusCode).toBe(400);

    const create = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: auth(),
      payload: { username: "biguser2", password: big, role: "USER" },
    });
    expect(create.statusCode).toBe(400);

    const reset = await app.inject({
      method: "PUT",
      url: `/api/users/${aliceId}`,
      headers: auth(),
      payload: { password: big },
    });
    expect(reset.statusCode).toBe(400);

    // Nothing was created by the rejected attempts.
    expect(await ctx.users.findByUsername("biguser")).toBeNull();
    expect(await ctx.users.findByUsername("biguser2")).toBeNull();
  });

  it("accepts boundary lengths (12 and 128) and rejects 11", async () => {
    const ok12 = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "edge12", password: pw(12) },
    });
    expect(ok12.statusCode).toBe(201);

    const ok128 = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "edge128", password: pw(128) },
    });
    expect(ok128.statusCode).toBe(201);

    const short = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "edge11", password: pw(11) },
    });
    expect(short.statusCode).toBe(400);
  });

  it("change-password is rate-limited against online guessing", async () => {
    // Isolated IP bucket so this loop cannot flake neighboring tests.
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: auth(),
        remoteAddress: "203.0.113.77",
        payload: { currentPassword: "Wrong-Password-1!", newPassword: pw(20) },
      });
      codes.push(res.statusCode);
    }
    expect(codes).toContain(400);
    expect(codes).toContain(429);
  });

  it("self-service change enforces the same cap", async () => {
    const queue = await app.inject({ method: "GET", url: "/api/registration-requests?status=pending", headers: auth() });
    const reqId = (queue.json() as { requests: Array<{ id: string; username: string }> }).requests.find(
      (r) => r.username === "edge12",
    )!.id;
    const approve = await app.inject({
      method: "POST",
      url: `/api/registration-requests/${reqId}/approve`,
      headers: auth(),
      payload: { role: "USER" },
    });
    expect(approve.statusCode).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "edge12", password: pw(12) },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "proxvm_session");
    const headers = { cookie: `${cookie?.name}=${cookie?.value}`, "x-csrf-token": (login.json() as { csrfToken: string }).csrfToken };
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers,
      payload: { currentPassword: pw(12), newPassword: pw(500) },
    });
    expect(res.statusCode).toBe(400);
  });
});
