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

describe("VM network isolation", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let user: Session;
  let vmId: string;
  let clusterEnabled = true;
  const rules: Array<Record<string, unknown>> = [];
  const calls: string[] = [];

  const fakeProxmox = {
    clusterFirewallOptions: async () => ({ enable: clusterEnabled ? 1 : 0 }),
    guestFirewallOptions: async () => ({ enable: 1, policy_in: "DROP", policy_out: "DROP" }),
    setGuestFirewallOptions: async (_n: string, _v: number, opts: unknown) => {
      calls.push(`options:${JSON.stringify(opts)}`);
      return {};
    },
    guestFirewallRules: async () => [...rules],
    createGuestFirewallRule: async (_n: string, _v: number, rule: Record<string, unknown>) => {
      calls.push(`create:${rule.type}:${rule.dport ?? rule.proto ?? "*"}`);
      rules.push({ pos: rules.length, ...rule });
      return {};
    },
    deleteGuestFirewallRule: async (_n: string, _v: number, pos: number) => {
      calls.push(`delete:${pos}`);
      const idx = rules.findIndex((r) => r.pos === pos);
      if (idx >= 0) rules.splice(idx, 1);
      return {};
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
    const ctx = { ...base, getProxmoxClient: async () => fakeProxmox as never };
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
    const vm = await ctx.vms.create({ vmid: 200, node: "node1", name: "locked-down" });
    vmId = vm.id;
    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
    user = await login(app, "bob", "Bob-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const authA = () => ({ cookie: admin.cookie, "x-csrf-token": admin.csrf });
  const authU = () => ({ cookie: user.cookie, "x-csrf-token": user.csrf });

  it("isolates with default-deny plus explicit allows, then removes only its own rules", async () => {
    const on = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/firewall`,
      headers: authA(),
      payload: { isolated: true, allowFrom: "192.168.1.22", allowDnsTo: "192.168.1.1" },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ isolated: true });
    expect(calls).toContainEqual(expect.stringMatching(/"policy_in":"DROP"/));
    expect(rules).toHaveLength(5);

    const status = await app.inject({ method: "GET", url: `/api/vms/${vmId}/firewall`, headers: authA() });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ isolated: true, enabled: true, policyIn: "DROP" });

    // Hand-made rule is listed but protected.
    rules.push({ pos: 99, action: "ACCEPT", type: "in", comment: "hand-made" });
    const delHand = await app.inject({ method: "DELETE", url: `/api/vms/${vmId}/firewall/rules/99`, headers: authA() });
    expect(delHand.statusCode).toBe(400);

    const off = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/firewall`,
      headers: authA(),
      payload: { isolated: false },
    });
    expect(off.statusCode).toBe(200);
    expect(rules.filter((r) => String(r.comment ?? "").startsWith("proxvm-"))).toHaveLength(0);
    expect(rules.some((r) => r.comment === "hand-made")).toBe(true);
    expect(calls).toContainEqual(expect.stringMatching(/"policy_in":"ACCEPT"/));
  });

  it("refuses when the cluster firewall is off and enforces access", async () => {
    clusterEnabled = false;
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/vms/${vmId}/firewall`,
        headers: authA(),
        payload: { isolated: true },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    } finally {
      clusterEnabled = true;
    }
    const denied = await app.inject({ method: "GET", url: `/api/vms/${vmId}/firewall`, headers: authU() });
    expect([401, 403, 404]).toContain(denied.statusCode);
    const badRule = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/firewall/rules`,
      headers: authA(),
      payload: { action: "ACCEPT", type: "in", dport: "99999" },
    });
    expect(badRule.statusCode).toBe(400);
  });
});
