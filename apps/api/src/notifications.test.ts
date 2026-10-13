import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { createCore, makeLogger, hashPassword, type CoreContext, type LocalConfig } from "@proxvm/core";
import { buildApp } from "../src/app.js";
import RedisMockCtor from "ioredis-mock";

const masterKey = "n".repeat(64);

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

describe("notifications API + triggers", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let aliceId: string;

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
      passwordHash: await hashPassword("Alice-Password-1!"),
      roles: ["USER"],
    });
    aliceId = alice.id;
    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (s: Session) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

  it("requires authentication on all notification endpoints", async () => {
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/notifications/unread-count" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/notifications/read", payload: {} })).statusCode).toBe(401);
  });

  it("ticket filing notifies admins (not the filer)", async () => {
    const alice = await login(app, "alice", "Alice-Password-1!");
    const ticket = await app.inject({
      method: "POST",
      url: "/api/tickets",
      headers: auth(alice),
      payload: { title: "Help with RDP", body: "Cannot connect since Tuesday." },
    });
    expect(ticket.statusCode).toBe(201);
    const adminList = await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: admin.cookie } });
    const items = (adminList.json() as { notifications: Array<{ kind: string; title: string }> }).notifications;
    expect(items.filter((n) => n.kind === "ticket").length).toBeGreaterThanOrEqual(1);
    const aliceCount = await app.inject({
      method: "GET",
      url: "/api/notifications/unread-count",
      headers: { cookie: alice.cookie },
    });
    expect((aliceCount.json() as { count: number }).count).toBe(0);
  });

  it("registration requests and new users notify admins", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "newbie", password: "Newbie-Password-1!" },
    });
    expect(reg.statusCode).toBe(201);
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: auth(admin),
      payload: { username: "carol", password: "Carol-Password-1!", role: "USER" },
    });
    expect(created.statusCode).toBe(200);
    const adminList = await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: admin.cookie } });
    const kinds = (adminList.json() as { notifications: Array<{ kind: string }> }).notifications.map((n) => n.kind);
    expect(kinds).toContain("registration");
    expect(kinds).toContain("user");
    const carol = await ctx.users.findByUsername("carol");
    await ctx.users.deleteGuarded(carol!.id);
    void aliceId;
  });

  it("read-state is per-viewer and validated", async () => {
    const count = await app.inject({ method: "GET", url: "/api/notifications/unread-count", headers: { cookie: admin.cookie } });
    expect((count.json() as { count: number }).count).toBeGreaterThanOrEqual(3);
    const marked = await app.inject({
      method: "POST",
      url: "/api/notifications/read",
      headers: auth(admin),
      payload: { all: true },
    });
    expect((marked.json() as { marked: number }).marked).toBeGreaterThanOrEqual(3);
    const after = await app.inject({ method: "GET", url: "/api/notifications/unread-count", headers: { cookie: admin.cookie } });
    expect((after.json() as { count: number }).count).toBe(0);
    // Malformed ids are rejected at the schema boundary (strict, like
    // every other endpoint); the service additionally ignores them.
    const bad = await app.inject({
      method: "POST",
      url: "/api/notifications/read",
      headers: auth(admin),
      payload: { ids: ["not-a-uuid"] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("/me/activity shows only the caller's own events without detail blobs", async () => {
    const alice = await login(app, "alice", "Alice-Password-1!");
    const res = await app.inject({ method: "GET", url: "/api/me/activity", headers: { cookie: alice.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { activity: Array<{ event: string; vmId: string | null }> };
    expect(body.activity.length).toBeGreaterThanOrEqual(1);
    expect(body.activity.every((a) => !("detail" in a))).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/me/activity" })).statusCode).toBe(401);
  });
});
