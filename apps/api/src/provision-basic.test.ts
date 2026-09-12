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

const masterKey = "f".repeat(64);

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

describe("Basic/Advanced provisioning requests", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let operator: Session;
  let plain: Session;
  let templateId: string;
  let bobId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });

    await ctx.settings.set("proxmox.url", "https://proxmox.example:8006");
    await ctx.settings.set("proxmox.token_id", "root@pam!test");
    await ctx.settings.set("proxmox.token_secret", "test-secret-value");
    await ctx.settings.set("proxmox.default_node", "node1");
    await ctx.settings.set("proxmox.default_storage", "local-lvm");
    await ctx.settings.set("proxmox.default_network", "vmbr0");

    const template = await ctx.templates.register({
      name: "debian",
      node: "node1",
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

    await ctx.users.create({
      username: "admin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    await ctx.users.create({
      username: "op",
      passwordHash: await hashPassword("Operator-Pass-1!"),
      roles: ["OPERATOR"],
    });
    await ctx.users.create({
      username: "eve",
      passwordHash: await hashPassword("Eve-Password-1!"),
      roles: ["USER"],
    });
    const bob = await ctx.users.create({
      username: "bob",
      passwordHash: await hashPassword("Bob-Password-1!"),
      roles: ["USER"],
    });
    bobId = bob.id;

    app = await buildApp({ setupMode: false, ctx });
    (app as unknown as { queue: unknown }).queue = {
      add: async () => ({ id: "bull-1" }),
    };
    admin = await login(app, "admin", "Admin-Password-1!");
    operator = await login(app, "op", "Operator-Pass-1!");
    plain = await login(app, "eve", "Eve-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  async function jobRequest(jobId: string, s: Session): Promise<Record<string, unknown>> {
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { cookie: s.cookie },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { job: { request: Record<string, unknown> } }).job.request;
  }

  it("minimal Basic request resolves server-side defaults into a full request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf },
      payload: {
        name: "basic-01",
        templateId,
        password: "Basic-Password-1!",
      },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const req = await jobRequest(jobId, operator);
    expect(req).toMatchObject({
      name: "basic-01",
      templateId,
      node: "node1",
      storage: "local-lvm",
      cpu: 2,
      ramMb: 4096,
      diskGb: 32,
      guestUser: "deploy",
      osType: "linux",
    });
    expect(req.network).toMatchObject({ bridge: "vmbr0", mode: "dhcp" });
    expect(req.password).toBe("[REDACTED]");
  });

  it("explicit Advanced request is preserved verbatim through the same pipeline", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: {
        name: "adv-01",
        templateId,
        node: "node1",
        cpu: 4,
        ramMb: 8192,
        diskGb: 64,
        storage: "local-lvm",
        network: { bridge: "vmbr0", vlan: 7, mode: "dhcp" },
        osType: "linux",
        protocols: ["rdp"],
        guestUser: "operator",
        password: "Advanced-Pass-1!",
        linkedClone: false,
        assignToUserIds: [bobId],
      },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const req = await jobRequest(jobId, admin);
    expect(req).toMatchObject({
      cpu: 4,
      ramMb: 8192,
      diskGb: 64,
      protocols: ["rdp"],
      guestUser: "operator",
      linkedClone: false,
      assignToUserIds: [bobId],
    });
    expect(req.network).toMatchObject({ bridge: "vmbr0", vlan: 7 });
  });

  it("duplicate submissions while a same-name job is active are rejected (409)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf },
      payload: { name: "dup-01", templateId, password: "Basic-Password-1!" },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf },
      payload: { name: "dup-01", templateId, password: "Basic-Password-1!" },
    });
    expect(second.statusCode).toBe(409);

    // A different name still provisions fine.
    const other = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf },
      payload: { name: "dup-02", templateId, password: "Basic-Password-1!" },
    });
    expect(other.statusCode).toBe(202);

    // Once the first job is terminal, the name can be reused.
    const { jobId } = first.json() as { jobId: string };
    await ctx.jobs.updateStatus(jobId, "FAILED", "test terminal");
    const retry = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf },
      payload: { name: "dup-01", templateId, password: "Basic-Password-1!" },
    });
    expect(retry.statusCode).toBe(202);
  });

  it("static networking without gateway is rejected with no job created", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf },
      payload: {
        name: "static-bad-01",
        templateId,
        network: { mode: "static", ip: "10.0.0.5" },
        password: "Basic-Password-1!",
      },
    });
    expect(res.statusCode).toBe(400);
    const jobs = await ctx.jobs.list({ limit: 100 });
    expect(jobs.some((j) => (j.request as Record<string, unknown>).name === "static-bad-01")).toBe(false);
  });

  it("provision-time assignment honors DB-backed vm.edit grants", async () => {
    // bob: legacy USER + custom vm.create/vm.edit grants -> may assign.
    await ctx.db.query("INSERT INTO user_permissions (user_id, permission) VALUES ($1, 'vm.create'), ($1, 'vm.edit')", [bobId]);
    const bob = await login(app, "bob", "Bob-Password-1!");
    const ok = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: bob.cookie, "x-csrf-token": bob.csrf },
      payload: { name: "grant-ok-01", templateId, password: "Basic-Password-1!", assignToUserIds: [bobId] },
    });
    expect(ok.statusCode).toBe(202);

    // dave: legacy USER + custom vm.create only -> assignment denied, plain ok.
    // (A dedicated user: mutating eve here would pollute later tests.)
    const dave = await ctx.users.create({
      username: "dave",
      passwordHash: await hashPassword("Dave-Password-1!"),
      roles: ["USER"],
    });
    await ctx.db.query("INSERT INTO user_permissions (user_id, permission) VALUES ($1, 'vm.create')", [dave.id]);
    const daveSession = await login(app, "dave", "Dave-Password-1!");
    const denied = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: daveSession.cookie, "x-csrf-token": daveSession.csrf },
      payload: { name: "grant-no-01", templateId, password: "Basic-Password-1!", assignToUserIds: [bobId] },
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: daveSession.cookie, "x-csrf-token": daveSession.csrf },
      payload: { name: "grant-no-02", templateId, password: "Basic-Password-1!" },
    });
    expect(allowed.statusCode).toBe(202);
  });

  it("template-unsupported protocols and unknown users are rejected (400)", async () => {
    const badProto = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf },
      payload: { name: "bad-01", templateId, protocols: ["vnc"], password: "Basic-Password-1!" },
    });
    expect(badProto.statusCode).toBe(400);

    const badUser = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf },
      payload: {
        name: "bad-02",
        templateId,
        password: "Basic-Password-1!",
        assignToUserIds: ["11111111-1111-4111-8111-111111111111"],
      },
    });
    expect(badUser.statusCode).toBe(400);
  });

  it("normal USER cannot provision or read defaults (403); validation still applies to all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: plain.cookie, "x-csrf-token": plain.csrf },
      payload: { name: "nope", templateId, password: "Basic-Password-1!" },
    });
    expect(res.statusCode).toBe(403);

    const defs = await app.inject({
      method: "GET",
      url: "/api/provisioning/defaults",
      headers: { cookie: plain.cookie },
    });
    expect(defs.statusCode).toBe(403);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/vms/provision",
      headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf },
      payload: { name: "", templateId, password: "short" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("defaults endpoint returns configured values without secrets (operator-safe)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/provisioning/defaults?templateId=${templateId}`,
      headers: { cookie: operator.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // Proxmox is unconfigured in tests -> unverified configured fallbacks
    expect(body.verified).toBe(false);
    expect(body.node).toBe("node1");
    expect(body.storage).toBe("local-lvm");
    expect(body.bridge).toBe("vmbr0");
    expect(body.cpu).toBe(2);
    expect(body.protocols).toEqual(["ssh", "rdp"]);
    expect(JSON.stringify(body)).not.toContain("test-secret-value");
  });
});
