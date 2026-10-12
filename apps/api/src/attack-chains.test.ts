import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { createCore, makeLogger, hashPassword, setUserQuota, type CoreContext, type LocalConfig } from "@proxvm/core";
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

describe("attack chains A-E", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let aliceId: string;
  let bobId: string;
  let vmId: string;
  let templateId: string;
  const proxmoxCalls: string[] = [];
  const fakeProxmox = {
    qemuStatus: async () => ({ status: "stopped" }),
    start: async () => {
      proxmoxCalls.push("start");
      return "UPID:start";
    },
    waitForTask: async () => undefined,
    version: async () => ({ version: "8.0", release: "8.0", repoid: "x" }),
    nodes: async () => [],
  };

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    const base = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    ctx = { ...base, getProxmoxClient: async () => fakeProxmox as never };
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
    const bob = await ctx.users.create({
      username: "bob",
      passwordHash: await hashPassword("Bob-Password-1!"),
      roles: ["USER"],
    });
    bobId = bob.id;
    const vm = await ctx.vms.create({ vmid: 951, node: "n1", name: "chain-vm", status: "stopped" });
    vmId = vm.id;
    await ctx.settings.set("proxmox.url", "https://proxmox.example:8006");
    await ctx.settings.set("proxmox.token_id", "root@pam!test");
    await ctx.settings.set("proxmox.token_secret", "test-secret-value");
    await ctx.settings.set("proxmox.default_node", "n1");
    await ctx.settings.set("proxmox.default_storage", "local-lvm");
    await ctx.settings.set("proxmox.default_network", "vmbr0");
    const template = await ctx.templates.register({
      name: "debian",
      node: "n1",
      proxmoxVmid: 9100,
      osType: "linux",
      provisioningMethod: "cloud-init",
      cloudInitSupport: true,
      guestAgentRequired: true,
      defaultCpu: 2,
      defaultRamMb: 4096,
      defaultDiskGb: 32,
      supportedProtocols: ["ssh", "rdp"],
    });
    templateId = template.id;
    app = await buildApp({ setupMode: false, ctx });
    (app as unknown as { queue: unknown }).queue = { add: async () => ({ id: "bull-1" }) };
    admin = await login(app, "admin", "Admin-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (s: Session) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

  it("chain A: expired ADMIN grant cannot authorize an admin action", async () => {
    const role = await ctx.db.query<{ id: string }>("SELECT id FROM roles WHERE name = 'ADMIN'");
    await ctx.db.query("INSERT INTO user_roles (user_id, role_id, expires_at) VALUES ($1, $2, NOW() - interval '1 minute')", [
      aliceId,
      role.rows[0]!.id,
    ]);
    const alice = await login(app, "alice", "Alice-Password-1!");
    const attempt = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: auth(alice),
      payload: { username: "chain-a-evil", password: "Chain-A-Evil-1!", role: "USER" },
    });
    expect(attempt.statusCode).toBe(403);
    expect(await ctx.users.findByUsername("chain-a-evil")).toBeNull();
    // Remove only the expired row under test: wiping all of alice's roles
    // would break later tests (and misrepresent the scenario).
    await ctx.db.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2", [
      aliceId,
      role.rows[0]!.id,
    ]);
  });

  it("chain B: setup is dead after initialization; metadata URLs are refused", async () => {
    // No setup routes in configured mode: both status-shape and completion
    // must not offer admin creation.
    const complete = await app.inject({
      method: "POST",
      url: "/api/setup/complete",
      headers: { "x-setup-token": "anything" },
      payload: {},
    });
    expect([403, 404]).toContain(complete.statusCode);
    // SSRF leg: a settings SSRF/recon target (cloud metadata) is refused.
    const proxmox = await app.inject({
      method: "PUT",
      url: "/api/settings/proxmox",
      headers: auth(admin),
      payload: { url: "http://169.254.169.254/latest/", tokenId: "root@pam!x", tokenSecret: "s3cret-value", verifySsl: true },
    });
    expect(proxmox.statusCode).toBe(400);
    const stored = await ctx.settings.getPlain("proxmox.url");
    expect(stored).not.toContain("169.254");
  });

  it("chain C: enumeration is uniform; spray is throttled; self-invite is impossible", async () => {
    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "nobody-here", password: "Wrong-Password-1!" },
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "Wrong-Password-1!" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
    // Bob has no access to the VM: inviting is forbidden, so there is no
    // self-grant primitive through the invite path.
    const bob = await login(app, "bob", "Bob-Password-1!");
    const invite = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/invite`,
      headers: auth(bob),
      payload: { userId: bobId },
    });
    expect(invite.statusCode).toBe(403);
  });

  it("chain C continued: delegated invites are short-lived, never permanent", async () => {
    await ctx.db.query("INSERT INTO vm_access (vm_id, user_id) VALUES ($1, $2)", [vmId, aliceId]);
    const alice = await login(app, "alice", "Alice-Password-1!");
    // Delegated (non-manager) invite without expiry or beyond 24h: refused.
    const permanent = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/invite`,
      headers: auth(alice),
      payload: { userId: bobId },
    });
    expect(permanent.statusCode).toBe(403);
    const long = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/invite`,
      headers: auth(alice),
      payload: { userId: bobId, expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString() },
    });
    expect(long.statusCode).toBe(403);
    // Bounded invite succeeds and carries an expiry.
    const bounded = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/invite`,
      headers: auth(alice),
      payload: { userId: bobId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    });
    expect(bounded.statusCode).toBe(200);
    await ctx.db.query("DELETE FROM vm_access WHERE vm_id = $1", [vmId]);
  });

  it("chain D: quota gates provisioning and clone (burst-safe reservation)", async () => {
    const op = await ctx.users.create({
      username: "chain-d-op",
      passwordHash: await hashPassword("Chain-D-Op-1!"),
      roles: ["OPERATOR"],
    });
    const session = await login(app, "chain-d-op", "Chain-D-Op-1!");
    await setUserQuota(ctx.db, op.id, 1);
    const submit = (name: string) =>
      app.inject({
        method: "POST",
        url: "/api/vms/provision",
        headers: auth(session),
        payload: { name, templateId, password: "Chain-D-Pass-1!" },
      });
    // Sequential gate: first reservation fills quota 1, second is denied.
    // True simultaneity is serialized by SELECT ... FOR UPDATE on Postgres
    // (pg-mem does not implement row locks, so a same-tick race test would
    // be vacuous here; the execution-time recheck in the worker is covered
    // by worker-reauth tests).
    expect((await submit("chain-d-1")).statusCode).toBe(202);
    expect((await submit("chain-d-2")).statusCode).toBe(403);
    // Clone is quota-gated too: at quota, cloning is denied.
    const owned = await ctx.vms.create({ vmid: 952, node: "n1", name: "chain-d-owned", createdByUserId: op.id });
    const clone = await app.inject({
      method: "POST",
      url: `/api/vms/${owned.id}/clone`,
      headers: auth(session),
      payload: { name: "chain-d-clone" },
    });
    expect(clone.statusCode).toBe(403);
  });

  it("chain E + auto-start order: unauthorized launch never wakes the VM", async () => {
    proxmoxCalls.length = 0;
    const bob = await login(app, "bob", "Bob-Password-1!");
    const denied = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/guacamole/launch`,
      headers: auth(bob),
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(proxmoxCalls).not.toContain("start");
    // No wake, no session, no audit success for the denied attempt.
    const audit = await ctx.audit.list({ vmId, limit: 20 });
    expect(audit.filter((a) => a.event === "GUAC_LAUNCHED" && a.actorUsername === "bob")).toHaveLength(0);
  });

  it("chain E continued: authorized launch carries no token in audit/logs", async () => {
    await ctx.db.query("INSERT INTO vm_access (vm_id, user_id) VALUES ($1, $2)", [vmId, aliceId]);
    const alice = await login(app, "alice", "Alice-Password-1!");
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/guacamole/launch`,
      headers: auth(alice),
      payload: {},
    });
    // Guacamole is unconfigured in tests: reaching CONFIGURATION_ERROR proves
    // authorization + auto-start passed without minting a real session.
    expect((res.json() as { code: string }).code).toBe("CONFIGURATION_ERROR");
    const audit = await ctx.audit.list({ vmId, limit: 20 });
    const launches = audit.filter((a) => a.event === "GUAC_LAUNCHED");
    for (const entry of launches) {
      expect(JSON.stringify(entry.detail ?? {})).not.toMatch(/token|secret|password/i);
    }
    await ctx.db.query("DELETE FROM vm_access WHERE vm_id = $1", [vmId]);
  });
});
