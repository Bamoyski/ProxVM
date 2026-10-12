import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { createCore, makeLogger, hashPassword, type CoreContext, type LocalConfig } from "@proxvm/core";
import { buildApp } from "../src/app.js";
import RedisMockCtor from "ioredis-mock";

const masterKey = "c".repeat(64);

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

async function makeCtx(): Promise<CoreContext> {
  const mem = newDb();
  const { Pool: MemPool } = mem.adapters.createPg();
  const pool = new MemPool() as unknown as Pool;
  const ctx = await createCore(localConfig, {
    db: pool,
    redis: new RedisMockCtor() as never,
    logger: makeLogger("test"),
  });
  await ctx.users.create({
    username: "admin",
    passwordHash: await hashPassword("Admin-Password-1!"),
    roles: ["ADMIN"],
  });
  return ctx;
}

describe("transport security", () => {
  it("ignores spoofed X-Forwarded-For from untrusted peers", async () => {
    const ctx = await makeCtx();
    const app = await buildApp({ setupMode: false, ctx });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-forwarded-for": "1.2.3.4" },
        remoteAddress: "9.9.9.9",
        payload: { username: "admin", password: "Admin-Password-1!" },
      });
      expect(res.statusCode).toBe(200);
      const rows = await ctx.db.query<{ ip: string }>(
        "SELECT ip FROM audit_logs WHERE event = 'LOGIN' ORDER BY created_at DESC LIMIT 1",
      );
      expect(rows.rows[0]!.ip).toBe("9.9.9.9");
      const setCookie = res.headers["set-cookie"];
      expect(String(setCookie)).not.toContain("Secure");
    } finally {
      await app.close();
    }
  });

  it("hides Proxmox infrastructure detail from non-operators", async () => {
    const ctx = await makeCtx();
    // Dead Proxmox endpoint: fast refusal, deterministic 502s.
    await ctx.settings.set("proxmox.url", "http://127.0.0.1:9", { category: "infrastructure" });
    await ctx.settings.set("proxmox.token_id", "root@pam!test", { category: "infrastructure" });
    await ctx.settings.set("proxmox.token_secret", "test-secret-value", { encrypted: true, category: "infrastructure" });
    const vm = await ctx.vms.create({ vmid: 901, node: "node1", name: "fw-vm", status: "stopped" });
    const op = await ctx.users.create({
      username: "op",
      passwordHash: await hashPassword("Operator-Pass-1!"),
      roles: ["OPERATOR"],
    });
    const narrow = await ctx.users.create({
      username: "narrow",
      passwordHash: await hashPassword("Narrow-Pass-1!"),
      roles: [],
    });
    const app = await buildApp({ setupMode: false, ctx });
    try {
      const loginFull = async (username: string, password: string) => {
        const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
        expect(res.statusCode).toBe(200);
        const cookie = res.cookies.find((c) => c.name === "proxvm_session");
        return {
          cookie: `${cookie?.name}=${cookie?.value}`,
          "x-csrf-token": (res.json() as { csrfToken: string }).csrfToken,
        };
      };
      const loginAs = async (username: string, password: string) => {
        const h = await loginFull(username, password);
        return { cookie: h.cookie };
      };
      const adminHeaders = await loginFull("admin", "Admin-Password-1!");
      // Custom role with exactly vm.read + proxmox.read, plus VM grants.
      const role = await app.inject({
        method: "POST",
        url: "/api/roles",
        headers: adminHeaders,
        payload: { name: "Reader", permissions: ["vm.read", "proxmox.read"] },
      });
      expect(role.statusCode).toBe(200);
      const roleId = (role.json() as { role: { id: string } }).role.id;
      expect((await app.inject({ method: "POST", url: `/api/users/${narrow.id}/roles`, headers: adminHeaders, payload: { roleId } })).statusCode).toBe(200);
      // Direct grants (the managed HTTP path rolls back without Guacamole).
      await ctx.vms.setAccess(vm.id, narrow.id, null);
      await ctx.vms.setAccess(vm.id, op.id, null);

      const opAuth = await loginAs("op", "Operator-Pass-1!");
      const opRes = await app.inject({ method: "GET", url: `/api/vms/${vm.id}/firewall`, headers: opAuth });
      expect(opRes.statusCode).toBe(502);
      expect((opRes.json() as { detail?: unknown }).detail).toBeTruthy();

      const narrowAuth = await loginAs("narrow", "Narrow-Pass-1!");
      const narrowRes = await app.inject({ method: "GET", url: `/api/vms/${vm.id}/firewall`, headers: narrowAuth });
      expect(narrowRes.statusCode).toBe(502);
      expect(narrowRes.json() as object).not.toHaveProperty("detail");
    } finally {
      await app.close();
    }
  });

  it("upgrades to Secure cookies over TLS and mirrors attributes on clear", async () => {
    process.env.PROXVM_TRUST_PROXY = "1";
    const ctx = await makeCtx();
    const app = await buildApp({ setupMode: false, ctx });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-forwarded-proto": "https" },
        payload: { username: "admin", password: "Admin-Password-1!" },
      });
      expect(res.statusCode).toBe(200);
      const setCookie = String(res.headers["set-cookie"]);
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("SameSite=Strict");

      const cookie = res.cookies.find((c) => c.name === "proxvm_session");
      const out = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: {
          cookie: `${cookie?.name}=${cookie?.value}`,
          "x-csrf-token": (res.json() as { csrfToken: string }).csrfToken,
          "x-forwarded-proto": "https",
        },
        payload: {},
      });
      expect(out.statusCode).toBe(200);
      expect(String(out.headers["set-cookie"])).toContain("Secure");
    } finally {
      delete process.env.PROXVM_TRUST_PROXY;
      await app.close();
    }
  });
});
