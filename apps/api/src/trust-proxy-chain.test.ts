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

// Tunnel egress for these tests (mirrors the documented production value).
const TUNNEL_HOP = "192.168.1.138";

describe("tunnel client-IP resolution", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let savedEnv: string | undefined;
  let envWasSet: boolean;

  beforeAll(async () => {
    // buildApp reads PROXVM_TRUST_PROXY at build time; restore afterwards so
    // no other suite sharing this worker can observe the value.
    savedEnv = process.env.PROXVM_TRUST_PROXY;
    envWasSet = "PROXVM_TRUST_PROXY" in process.env;
    process.env.PROXVM_TRUST_PROXY = `172.16.0.0/12,10.0.0.0/8,127.0.0.1/32,::1/128,${TUNNEL_HOP}`;
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
  });

  afterAll(async () => {
    if (envWasSet) process.env.PROXVM_TRUST_PROXY = savedEnv as string;
    else delete process.env.PROXVM_TRUST_PROXY;
    await app.close();
  });

  async function lastLoginIp(): Promise<string | null> {
    const rows = await ctx.db.query<{ ip: string | null }>(
      "SELECT ip FROM audit_logs WHERE event = 'LOGIN' ORDER BY created_at DESC LIMIT 1",
    );
    return rows.rows[0]?.ip ?? null;
  }

  async function loginAs(headers: Record<string, string>, remoteAddress: string): Promise<number> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers,
      remoteAddress,
      payload: { username: "admin", password: "Admin-Password-1!" },
    });
    return res.statusCode;
  }

  it("resolves tunneled logins to the Cloudflare-reported client, not the tunnel hop", async () => {
    // Socket peer = tunnel egress (trusted); X-Forwarded-For carries the
    // edge-appended client first. Pre-fix this recorded 192.168.1.138.
    expect(await loginAs({ "x-forwarded-for": "203.0.113.9" }, TUNNEL_HOP)).toBe(200);
    expect(await lastLoginIp()).toBe("203.0.113.9");
  });

  it("ignores attacker-forged outer XFF entries behind the tunnel hop", async () => {
    expect(await loginAs({ "x-forwarded-for": "1.2.3.4, 203.0.113.10" }, TUNNEL_HOP)).toBe(200);
    expect(await lastLoginIp()).toBe("203.0.113.10");
  });

  it("still falls back to socket IP for untrusted direct connections", async () => {
    expect(await loginAs({ "x-forwarded-for": "1.2.3.4" }, "198.51.100.7")).toBe(200);
    expect(await lastLoginIp()).toBe("198.51.100.7");
  });

  it("keeps the tunnel hop out of threat findings (shared egress)", async () => {
    // The production pattern: several users' failures plus a success, all
    // recorded as the one cloudflared hop. Threat detection must not read
    // the hop as a single attacker spraying or a compromised login.
    for (let i = 0; i < 6; i++) {
      for (const actor of ["victim", "other", "third"]) {
        await ctx.audit.record({
          event: "LOGIN_FAILED",
          actorUsername: actor,
          ip: TUNNEL_HOP,
          detail: { reason: "bad-password" },
        });
      }
    }
    await ctx.audit.record({ event: "LOGIN", actorUsername: "victim", ip: TUNNEL_HOP });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "203.0.113.77" },
      remoteAddress: TUNNEL_HOP,
      payload: { username: "admin", password: "Admin-Password-1!" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "proxvm_session");

    const res = await app.inject({
      method: "GET",
      url: "/api/threats?days=2",
      headers: { cookie: `${cookie?.name}=${cookie?.value}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      findings: Array<{ id: string; ip: string | null; severity: string; summary: string }>;
    };

    // No spray/compromised/new-IP finding may name the hop, and nothing
    // carries it as an attacker IP.
    expect(body.findings.some((f) => f.id.includes("192-168-1-138"))).toBe(false);
    expect(body.findings.some((f) => f.ip === TUNNEL_HOP)).toBe(false);
    expect(body.findings.some((f) => f.severity === "critical")).toBe(false);

    // The account-scoped burst still fires — scrubbed of the hop address.
    const burst = body.findings.find((f) => f.id === "brute-force-account-victim");
    expect(burst?.severity).toBe("high");
    expect(burst?.ip).toBeNull();
    expect(burst?.summary).not.toContain(TUNNEL_HOP);
  });
});
