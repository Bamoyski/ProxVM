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

describe("domain migration tool", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let user: Session;

  const cfCalls: string[] = [];
  const records: Array<{ id: string; type: string; name: string; content: string; proxied: boolean; ttl: number }> = [
    { id: "r-old", type: "A", name: "proxvm.zone.example", content: "203.0.113.10", proxied: true, ttl: 1 },
  ];
  const fakeCf = {
    verifyToken: async () => ({ id: "tok", status: "active" }),
    getZone: async (zoneId: string) => {
      if (zoneId !== "zone-1") throw Object.assign(new Error("not found"), { statusCode: 404 });
      return { id: "zone-1", name: "zone.example", status: "active" };
    },
    listDnsRecords: async () => {
      cfCalls.push("list");
      return [...records];
    },
    createDnsRecord: async (_zone: string, r: { type: string; name: string; content: string; proxied?: boolean; ttl?: number }) => {
      cfCalls.push(`create:${r.name}`);
      const created = { id: `r-${records.length + 1}`, type: r.type, name: r.name, content: r.content, proxied: r.proxied ?? true, ttl: r.ttl ?? 1 };
      records.push(created);
      return created;
    },
    updateDnsRecord: async (_zone: string, id: string, patch: { content?: string; proxied?: boolean }) => {
      cfCalls.push(`update:${id}`);
      const rec = records.find((r) => r.id === id)!;
      if (patch.content !== undefined) rec.content = patch.content;
      if (patch.proxied !== undefined) rec.proxied = patch.proxied;
      return { ...rec };
    },
  };

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    const base: CoreContext = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    const ctx = { ...base, getCloudflareClient: async () => fakeCf as never };

    await ctx.users.create({
      username: "admin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    await ctx.users.create({
      username: "alice",
      passwordHash: await hashPassword("User-Password-1!"),
      roles: ["USER"],
    });

    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
    user = await login(app, "alice", "User-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const authA = () => ({ cookie: admin.cookie, "x-csrf-token": admin.csrf });
  const authU = () => ({ cookie: user.cookie, "x-csrf-token": user.csrf });

  it("starts unconfigured and validates canonical domains", async () => {
    const config = await app.inject({ method: "GET", url: "/api/domains/config", headers: authA() });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({ canonical: null, aliases: [], cloudflare: { configured: false } });

    const bad = await app.inject({
      method: "PUT",
      url: "/api/domains/config",
      headers: authA(),
      payload: { canonical: "not a domain!!" },
    });
    expect(bad.statusCode).toBe(400);

    const denied = await app.inject({ method: "GET", url: "/api/domains/config", headers: authU() });
    expect(denied.statusCode).toBe(403);
  });

  it("saves Cloudflare credentials masked and tests the connection", async () => {
    const save = await app.inject({
      method: "PUT",
      url: "/api/domains/cloudflare",
      headers: authA(),
      payload: { apiToken: "cf-test-token", zoneId: "zone-1" },
    });
    expect(save.statusCode).toBe(200);
    const test = await app.inject({ method: "POST", url: "/api/domains/cloudflare/test", headers: authA() });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: true, zone: { name: "zone.example" } });
    const dns = await app.inject({ method: "GET", url: "/api/domains/dns?search=proxvm", headers: authA() });
    expect(dns.statusCode).toBe(200);
    expect((dns.json() as { records: unknown[] }).records).toHaveLength(1);
  });

  it("switches domains, keeps the old DNS record, and accumulates aliases", async () => {
    const first = await app.inject({
      method: "PUT",
      url: "/api/domains/config",
      headers: authA(),
      payload: { canonical: "https://proxvm.zone.example/" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ canonical: "proxvm.zone.example", aliases: [] });

    const switched = await app.inject({
      method: "POST",
      url: "/api/domains/switch",
      headers: authA(),
      payload: { name: "proxvm1", proxied: true },
    });
    expect(switched.statusCode).toBe(200);
    const body = switched.json() as {
      record: { name: string; content: string };
      canonical: string;
      aliases: string[];
    };
    expect(body.record.name).toBe("proxvm1.zone.example");
    // Target copied from the old canonical record; old record untouched.
    expect(body.record.content).toBe("203.0.113.10");
    expect(records.find((r) => r.id === "r-old")).toBeTruthy();
    expect(body.canonical).toBe("proxvm1.zone.example");
    expect(body.aliases).toEqual(["proxvm.zone.example"]);
    expect(cfCalls).toContain("create:proxvm1.zone.example");

    // Switching to an explicitly given target works too.
    const second = await app.inject({
      method: "POST",
      url: "/api/domains/switch",
      headers: authA(),
      payload: { name: "proxvm2.zone.example", target: "203.0.113.20" },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { aliases: string[] }).aliases).toEqual([
      "proxvm.zone.example",
      "proxvm1.zone.example",
    ]);
  });

  it("redirects old alias GETs, never API traffic or unknown hosts", async () => {
    const redir = await app.inject({ method: "GET", url: "/vms/abc", headers: { host: "proxvm.zone.example" } });
    expect(redir.statusCode).toBe(301);
    expect(redir.headers.location).toBe("https://proxvm2.zone.example/vms/abc");

    const apiCall = await app.inject({
      method: "GET",
      url: "/api/vms",
      headers: { ...authA(), host: "proxvm.zone.example" },
    });
    expect(apiCall.statusCode).not.toBe(301);

    const post = await app.inject({ method: "POST", url: "/login", headers: { host: "proxvm.zone.example" }, payload: {} });
    expect(post.statusCode).not.toBe(301);

    const unknown = await app.inject({ method: "GET", url: "/", headers: { host: "new.example.com" } });
    expect(unknown.statusCode).not.toBe(301);

    const share = await app.inject({ method: "GET", url: "/api/s/sometoken", headers: { host: "proxvm1.zone.example" } });
    // Alias host + share path: redirect wins (410 would mean it passed through).
    expect(share.statusCode).toBe(301);
    expect(share.headers.location).toBe("https://proxvm2.zone.example/api/s/sometoken");
  });

  it("aliases can be removed", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: "/api/domains/aliases/proxvm.zone.example",
      headers: authA(),
    });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { aliases: string[] }).aliases).toEqual(["proxvm1.zone.example"]);
    const gone = await app.inject({ method: "GET", url: "/", headers: { host: "proxvm.zone.example" } });
    expect(gone.statusCode).not.toBe(301);
  });

  it("validates switch targets and supports copy-from", async () => {
    const asUrl = await app.inject({
      method: "POST",
      url: "/api/domains/switch",
      headers: authA(),
      payload: { name: "bad1", target: "http://192.168.1.19:8080" },
    });
    expect(asUrl.statusCode).toBe(400);
    const lanIp = await app.inject({
      method: "POST",
      url: "/api/domains/switch",
      headers: authA(),
      payload: { name: "bad2", target: "192.168.1.19" },
    });
    expect(lanIp.statusCode).toBe(400);
    expect(lanIp.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    // Copy type/target/proxied from the existing record by id.
    const copied = await app.inject({
      method: "POST",
      url: "/api/domains/switch",
      headers: authA(),
      payload: { name: "proxvm9", copyFrom: "r-old" },
    });
    expect(copied.statusCode).toBe(200);
    expect(copied.json()).toMatchObject({
      record: { name: "proxvm9.zone.example", content: "203.0.113.10" },
      canonical: "proxvm9.zone.example",
    });

    const missing = await app.inject({
      method: "POST",
      url: "/api/domains/switch",
      headers: authA(),
      payload: { name: "proxvm10", copyFrom: "no-such-id" },
    });
    expect(missing.statusCode).toBe(400);
  });
});
