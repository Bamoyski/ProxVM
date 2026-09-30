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

describe("site content CMS", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let user: Session;

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
    admin = await login(app, "admin", "Admin-Password-1!");
    user = await login(app, "bob", "Bob-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const authA = () => ({ cookie: admin.cookie, "x-csrf-token": admin.csrf });
  const authU = () => ({ cookie: user.cookie, "x-csrf-token": user.csrf });

  it("reads empty, writes validated entries, resets on empty", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/content" });
    expect(anon.statusCode).toBe(401);
    const empty = await app.inject({ method: "GET", url: "/api/content", headers: authU() });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ entries: {} });

    const denied = await app.inject({
      method: "PUT",
      url: "/api/content",
      headers: authU(),
      payload: { entries: { "contact.email": "x@y.zz" } },
    });
    expect(denied.statusCode).toBe(403);

    const badKey = await app.inject({
      method: "PUT",
      url: "/api/content",
      headers: authA(),
      payload: { entries: { "settings.proxmox": "evil" } },
    });
    expect(badKey.statusCode).toBe(400);
    const badEmail = await app.inject({
      method: "PUT",
      url: "/api/content",
      headers: authA(),
      payload: { entries: { "contact.email": "not-an-email" } },
    });
    expect(badEmail.statusCode).toBe(400);
    const badUrl = await app.inject({
      method: "PUT",
      url: "/api/content",
      headers: authA(),
      payload: { entries: { "contact.github": "javascript:alert(1)" } },
    });
    expect(badUrl.statusCode).toBe(400);
    const badTiers = await app.inject({
      method: "PUT",
      url: "/api/content",
      headers: authA(),
      payload: { entries: { "donate.tiers": "not json" } },
    });
    expect(badTiers.statusCode).toBe(400);

    const save = await app.inject({
      method: "PUT",
      url: "/api/content",
      headers: authA(),
      payload: {
        entries: {
          "contact.email": "a@b.cc",
          "donate.tiers": JSON.stringify([{ amount: "$1", blurb: "test" }]),
        },
      },
    });
    expect(save.statusCode).toBe(200);
    const read = await app.inject({ method: "GET", url: "/api/content", headers: authU() });
    expect(read.json()).toEqual({
      entries: {
        "contact.email": "a@b.cc",
        "donate.tiers": JSON.stringify([{ amount: "$1", blurb: "test" }]),
      },
    });
    const reset = await app.inject({
      method: "PUT",
      url: "/api/content",
      headers: authA(),
      payload: { entries: { "contact.email": "" } },
    });
    expect(reset.statusCode).toBe(200);
    const reread = await app.inject({ method: "GET", url: "/api/content", headers: authU() });
    expect((reread.json() as { entries: Record<string, string> }).entries["contact.email"]).toBeUndefined();
  });
});
