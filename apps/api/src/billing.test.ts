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

describe("billing foundations", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let user: Session;
  let userId: string;

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
    // OPERATOR (not ADMIN): holds vm.create so provision reaches the quota
    // gate, but is still subject to quotas like every non-administrator.
    const eve = await ctx.users.create({
      username: "eve",
      passwordHash: await hashPassword("Eve-Password-1!"),
      roles: ["OPERATOR"],
    });
    userId = eve.id;

    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
    user = await login(app, "eve", "Eve-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const authA = () => ({ cookie: admin.cookie, "x-csrf-token": admin.csrf });
  const authU = () => ({ cookie: user.cookie, "x-csrf-token": user.csrf });

  it("usage summary is admin-only and empty when nothing metered", async () => {
    const denied = await app.inject({ method: "GET", url: "/api/usage/summary?month=2026-01", headers: authU() });
    expect(denied.statusCode).toBe(403);
    const res = await app.inject({ method: "GET", url: "/api/usage/summary?month=2026-01", headers: authA() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ month: "2026-01", totalHours: 0, vms: [] });
    const bad = await app.inject({ method: "GET", url: "/api/usage/summary?month=junk", headers: authA() });
    expect(bad.statusCode).toBe(400);
    const csv = await app.inject({ method: "GET", url: "/api/usage/export?month=2026-01", headers: authA() });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("vm_id,vm_name,hours");
  });

  it("quotas default unlimited and gate provisioning for non-admins", async () => {
    const current = await app.inject({ method: "GET", url: `/api/users/${userId}/quota`, headers: authA() });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ maxVms: null });
    // Unlimited: sails past quota into body validation (400, not 403).
    const open = await app.inject({ method: "POST", url: "/api/vms/provision", headers: authU(), payload: {} });
    expect(open.statusCode).toBe(400);

    const set = await app.inject({
      method: "PUT",
      url: `/api/users/${userId}/quota`,
      headers: authA(),
      payload: { maxVms: 0 },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ maxVms: 0 });
    const blocked = await app.inject({ method: "POST", url: "/api/vms/provision", headers: authU(), payload: {} });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "FORBIDDEN" });

    const badValue = await app.inject({
      method: "PUT",
      url: `/api/users/${userId}/quota`,
      headers: authA(),
      payload: { maxVms: -2 },
    });
    expect(badValue.statusCode).toBe(400);
    const missing = await app.inject({
      method: "PUT",
      url: "/api/users/00000000-0000-0000-0000-000000000000/quota",
      headers: authA(),
      payload: { maxVms: 1 },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("tickets: users file and see own, admins see all and close", async () => {
    const filed = await app.inject({
      method: "POST",
      url: "/api/tickets",
      headers: authU(),
      payload: { title: " RDP is slow ", body: "Every evening." },
    });
    expect(filed.statusCode).toBe(201);
    const ticket = (filed.json() as { ticket: { id: string; title: string; status: string } }).ticket;
    expect(ticket.title).toBe("RDP is slow");
    const invalid = await app.inject({
      method: "POST",
      url: "/api/tickets",
      headers: authU(),
      payload: { title: "", body: "x" },
    });
    expect(invalid.statusCode).toBe(400);

    const mine = await app.inject({ method: "GET", url: "/api/tickets", headers: authU() });
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as { tickets: unknown[] }).tickets).toHaveLength(1);

    const all = await app.inject({ method: "GET", url: "/api/tickets?status=open", headers: authA() });
    expect((all.json() as { tickets: Array<{ id: string }> }).tickets.map((t) => t.id)).toContain(ticket.id);
    const close = await app.inject({
      method: "PATCH",
      url: `/api/tickets/${ticket.id}`,
      headers: authA(),
      payload: { status: "closed" },
    });
    expect(close.statusCode).toBe(200);
    expect((close.json() as { ticket: { status: string } }).ticket.status).toBe("closed");
    const userClose = await app.inject({
      method: "PATCH",
      url: `/api/tickets/${ticket.id}`,
      headers: authU(),
      payload: { status: "open" },
    });
    expect(userClose.statusCode).toBe(403);
  });

  it("announcements are null until set, visible to every signed-in user", async () => {
    const empty = await app.inject({ method: "GET", url: "/api/announcement", headers: authU() });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ text: null });
    const anon = await app.inject({ method: "GET", url: "/api/announcement" });
    expect(anon.statusCode).toBe(401);

    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: authA(),
      payload: { announcementText: "Maintenance Sunday", announcementLevel: "warn" },
    });
    expect(set.statusCode).toBe(200);
    const seen = await app.inject({ method: "GET", url: "/api/announcement", headers: authU() });
    expect(seen.json()).toEqual({ text: "Maintenance Sunday", level: "warn" });
    const cfg = await app.inject({ method: "GET", url: "/api/settings/app", headers: authA() });
    expect(cfg.json()).toMatchObject({
      settings: { announcementText: "Maintenance Sunday", announcementLevel: "warn" },
    });
    const clear = await app.inject({
      method: "PUT",
      url: "/api/settings/app",
      headers: authA(),
      payload: { announcementText: null },
    });
    expect(clear.statusCode).toBe(200);
    const gone = await app.inject({ method: "GET", url: "/api/announcement", headers: authU() });
    expect(gone.json()).toMatchObject({ text: null });
  });
});
