import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { createCore, makeLogger, hashPassword, type CoreContext, type LocalConfig } from "@proxvm/core";
import RedisMockCtor from "ioredis-mock";
import { buildApp } from "../src/app.js";

const masterKey = "4".repeat(64);

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
  secrets: { sessionSigningKey: "s".repeat(64), masterKeyId: "v1", masterKey },
};

interface Session {
  cookie: string;
  csrf: string;
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, username: string, password: string): Promise<Session> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "proxvm_session");
  return { cookie: `${cookie?.name}=${cookie?.value}`, csrf: (res.json() as { csrfToken: string }).csrfToken };
}

describe("CSRF tokens are derived from the session id, not stored", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;

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
      username: "alice",
      passwordHash: await hashPassword("Alice-Password-1!"),
      roles: ["USER"],
    });
    app = await buildApp({ setupMode: false, ctx });
  });

  afterAll(async () => {
    await app.close();
    await (ctx.db as Pool).end().catch(() => undefined);
  });

  it("login and /me return the same deterministic token (concurrent tabs)", async () => {
    const session = await login(app, "alice", "Alice-Password-1!");
    const reads = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({ method: "GET", url: "/api/me", headers: { cookie: session.cookie } }),
      ),
    );
    for (const r of reads) {
      expect(r.statusCode).toBe(200);
      expect((r.json() as { csrfToken: string }).csrfToken).toBe(session.csrf);
    }
  });

  it("rejects a state-changing request with a missing or wrong CSRF token", async () => {
    const session = await login(app, "alice", "Alice-Password-1!");
    const payload = { currentPassword: "Alice-Password-1!", newPassword: "New-Alice-Pass-1!" };

    const missing = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: session.cookie },
      payload,
    });
    expect(missing.statusCode).toBe(403);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: session.cookie, "x-csrf-token": "f".repeat(64) },
      payload,
    });
    expect(wrong.statusCode).toBe(403);
  });

  it("accepts the correct token and reaches the handler", async () => {
    const session = await login(app, "alice", "Alice-Password-1!");
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
      payload: { currentPassword: "wrong-password", newPassword: "New-Alice-Pass-1!" },
    });
    // CSRF passed, so the request reached the handler and failed on the
    // business rule instead of being rejected at the CSRF gate.
    expect(res.statusCode).toBe(400);
  });

  it("keeps a stable token under concurrent state-changing requests", async () => {
    const session = await login(app, "alice", "Alice-Password-1!");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "POST",
          url: "/api/auth/change-password",
          headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
          payload: { currentPassword: "wrong-password", newPassword: "New-Alice-Pass-1!" },
        }),
      ),
    );
    for (const r of results) expect(r.statusCode).toBe(400);
  });

  it("a revoked session is rejected even with its previously valid token", async () => {
    const session = await login(app, "alice", "Alice-Password-1!");
    const out = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    });
    expect(out.statusCode).toBe(200);

    const after = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
      payload: { currentPassword: "Alice-Password-1!", newPassword: "New-Alice-Pass-1!" },
    });
    expect(after.statusCode).toBe(401);
  });
});
