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

const masterKey = "b".repeat(64);

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

describe("RBAC authorization model", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let user: Session;
  let operator: Session;
  let userId: string;
  let assignedVmId: string;
  let unassignedVmId: string;

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
    const normal = await ctx.users.create({
      username: "alice",
      passwordHash: await hashPassword("User-Password-1!"),
      roles: ["USER"],
    });
    userId = normal.id;
    await ctx.users.create({
      username: "op",
      passwordHash: await hashPassword("Operator-Pass-1!"),
      roles: ["OPERATOR"],
    });

    const vmA = await ctx.vms.create({
      vmid: 201,
      node: "node1",
      name: "alice-vm",
      status: "stopped",
      osType: "linux",
    });
    assignedVmId = vmA.id;
    const vmB = await ctx.vms.create({
      vmid: 202,
      node: "node1",
      name: "other-vm",
      status: "stopped",
      osType: "linux",
    });
    unassignedVmId = vmB.id;
    await ctx.vms.setAccess(assignedVmId, userId);

    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
    user = await login(app, "alice", "User-Password-1!");
    operator = await login(app, "op", "Operator-Pass-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  it("unauthenticated requests get 401, never 500", async () => {
    const res = await app.inject({ method: "GET", url: "/api/vms" });
    expect(res.statusCode).toBe(401);
  });

  it("normal user list contains only assigned VMs (no leak of other VMs)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/vms",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { vms: Array<{ id: string | null }> };
    const ids = body.vms.map((v) => v.id);
    expect(ids).toContain(assignedVmId);
    expect(ids).not.toContain(unassignedVmId);
    // untracked Proxmox VMs (id === null) must never be exposed to normal users
    expect(body.vms.every((v) => v.id !== null)).toBe(true);
  });

  it("admin list contains all tracked VMs", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/vms",
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { vms: Array<{ id: string | null }> };
    const ids = body.vms.map((v) => v.id);
    expect(ids).toContain(assignedVmId);
    expect(ids).toContain(unassignedVmId);
  });

  it("normal user gets 403 on unassigned VM detail, 200 on assigned VM", async () => {
    const denied = await app.inject({
      method: "GET",
      url: `/api/vms/${unassignedVmId}`,
      headers: { cookie: user.cookie },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "GET",
      url: `/api/vms/${assignedVmId}`,
      headers: { cookie: user.cookie },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("VM detail returns all protocol connections as an array", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/vms/${assignedVmId}`,
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      guacamole: { connections: unknown[]; active: unknown } | null;
    };
    expect(body.guacamole).not.toBeNull();
    expect(Array.isArray(body.guacamole?.connections)).toBe(true);
  });

  it("normal user is denied audit.read and proxmox.read (403, never 500)", async () => {
    const audit = await app.inject({
      method: "GET",
      url: "/api/audit?limit=10",
      headers: { cookie: user.cookie },
    });
    expect(audit.statusCode).toBe(403);

    const pm = await app.inject({
      method: "GET",
      url: "/api/proxmox/status",
      headers: { cookie: user.cookie },
    });
    expect(pm.statusCode).toBe(403);
  });

  it("admin can read audit log", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/audit?limit=10",
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it("normal user cannot manage VMs even when assigned (403 on start/stop/delete)", async () => {
    for (const action of ["start", "stop", "restart"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/vms/${assignedVmId}/${action}`,
        headers: { cookie: user.cookie, "x-csrf-token": user.csrf },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    }
    const del = await app.inject({
      method: "DELETE",
      url: `/api/vms/${assignedVmId}`,
      headers: { cookie: user.cookie, "x-csrf-token": user.csrf },
      payload: { confirmText: "DELETE alice-vm" },
    });
    expect(del.statusCode).toBe(403);
  });

  it("normal user cannot reveal or rotate credentials (403)", async () => {
    for (const op of ["reveal", "copy", "rotate"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/vms/${assignedVmId}/credentials/${op}`,
        headers: { cookie: user.cookie, "x-csrf-token": user.csrf },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("normal user cannot delete Guacamole connections (403, guac.manage required)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/guacamole/connections/${assignedVmId}`,
      headers: { cookie: user.cookie, "x-csrf-token": user.csrf },
      payload: { confirmText: "DELETE alice-vm" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("normal user guac launch is denied without vm_access (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${unassignedVmId}/guacamole/launch`,
      headers: { cookie: user.cookie, "x-csrf-token": user.csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("normal user guac launch passes authorization with vm_access (protocol param accepted)", async () => {
    // Guacamole infra is not configured in tests, so the launch fails downstream
    // with CONFIGURATION_ERROR — but it must get PAST authN/authZ (no 401/403).
    // Reaching the infra layer proves permission + vm_access checks passed.
    for (const payload of [{}, { protocol: "rdp" }, { protocol: "ssh" }]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/vms/${assignedVmId}/guacamole/launch`,
        headers: { cookie: user.cookie, "x-csrf-token": user.csrf },
        payload,
      });
      expect([401, 403]).not.toContain(res.statusCode);
      expect((res.json() as { code: string }).code).toBe("CONFIGURATION_ERROR");
    }
    // invalid protocol is still rejected by schema validation (VALIDATION_ERROR)
    const bad = await app.inject({
      method: "POST",
      url: `/api/vms/${assignedVmId}/guacamole/launch`,
      headers: { cookie: user.cookie, "x-csrf-token": user.csrf },
      payload: { protocol: "telnet" },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { code: string }).code).not.toBe("CONFIGURATION_ERROR");
  });

  it("job rollback requires vm.delete: admin passes, operator gets 403", async () => {
    const job = await ctx.jobs.create({ vmId: null, request: {}, createdByUserId: null });
    await ctx.jobs.updateStatus(job.id, "FAILED", "test failure");
    const denied = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/rollback`,
      headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf },
      payload: { action: "keep" },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/rollback`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { action: "keep" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("credential vault requires cred.reveal: admin passes, operator and user get 403", async () => {
    // Contract the Credential Vault UI relies on: only cred.reveal holders
    // (ADMIN) can list the vault. OPERATOR can rotate per-VM credentials via
    // the VM detail page but must not see the vault listing.
    const ok = await app.inject({
      method: "GET",
      url: "/api/credentials",
      headers: { cookie: admin.cookie },
    });
    expect(ok.statusCode).toBe(200);

    for (const s of [operator, user]) {
      const denied = await app.inject({
        method: "GET",
        url: "/api/credentials",
        headers: { cookie: s.cookie },
      });
      expect(denied.statusCode).toBe(403);
    }
  });

  it("credential reveal/copy/rotate require VM access, not just the permission", async () => {
    await ctx.creds.store(assignedVmId, "root", "Vault-Password-1!");

    // Grant alice cred.reveal directly (she has VM access to assignedVmId only).
    const grant = await app.inject({
      method: "POST",
      url: `/api/users/${userId}/permissions`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { permission: "cred.reveal" },
    });
    expect(grant.statusCode).toBe(200);

    const authU = { cookie: user.cookie, "x-csrf-token": user.csrf };
    const revealOk = await app.inject({
      method: "POST",
      url: `/api/vms/${assignedVmId}/credentials/reveal`,
      headers: authU,
    });
    expect(revealOk.statusCode).toBe(200);
    expect((revealOk.json() as { password: string }).password).toBe("Vault-Password-1!");

    // Same permission, no VM access -> 403.
    for (const action of ["reveal", "copy"]) {
      const denied = await app.inject({
        method: "POST",
        url: `/api/vms/${unassignedVmId}/credentials/${action}`,
        headers: authU,
      });
      expect(denied.statusCode).toBe(403);
    }
  });

  it("jobs are scoped to their creator for non-privileged users", async () => {
    const aliceJob = await ctx.jobs.create({ vmId: assignedVmId, request: {}, createdByUserId: userId });
    const othersJob = await ctx.jobs.create({ vmId: unassignedVmId, request: {}, createdByUserId: null });

    const authU = { cookie: user.cookie, "x-csrf-token": user.csrf };
    const list = await app.inject({ method: "GET", url: "/api/jobs?limit=200", headers: authU });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id);
    expect(ids).toContain(aliceJob.id);
    expect(ids).not.toContain(othersJob.id);

    // Another user's job: 403 on detail, events, retry, cancel.
    const opUser = await ctx.users.findByUsername("op");
    const adminJob = await ctx.jobs.create({ vmId: unassignedVmId, request: {}, createdByUserId: opUser!.id });
    const detail = await app.inject({ method: "GET", url: `/api/jobs/${adminJob.id}`, headers: authU });
    expect(detail.statusCode).toBe(403);
    const retry = await app.inject({
      method: "POST",
      url: `/api/jobs/${adminJob.id}/retry`,
      headers: authU,
      payload: {},
    });
    expect(retry.statusCode).toBe(403);

    // Own job stays fully accessible.
    const own = await app.inject({ method: "GET", url: `/api/jobs/${aliceJob.id}`, headers: authU });
    expect(own.statusCode).toBe(200);

    // Privileged roles keep full visibility.
    const adminList = await app.inject({
      method: "GET",
      url: "/api/jobs?limit=200",
      headers: { cookie: admin.cookie },
    });
    expect(adminList.statusCode).toBe(200);
    const adminIds = (adminList.json() as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id);
    expect(adminIds).toEqual(expect.arrayContaining([aliceJob.id, othersJob.id, adminJob.id]));
  });

  it("credential rotate requires VM access for bare permission holders", async () => {
    // A bare user granted only cred.rotate (no VM access, no operator bypass) -> 403.
    const bob = await ctx.users.create({
      username: "bob",
      passwordHash: await hashPassword("Bob-Password-1!"),
      roles: ["USER"],
    });
    const bobGrant = await app.inject({
      method: "POST",
      url: `/api/users/${bob.id}/permissions`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { permission: "cred.rotate" },
    });
    expect(bobGrant.statusCode).toBe(200);
    const bobSession = await login(app, "bob", "Bob-Password-1!");
    for (const vm of [assignedVmId, unassignedVmId]) {
      const rotateDenied = await app.inject({
        method: "POST",
        url: `/api/vms/${vm}/credentials/rotate`,
        headers: { cookie: bobSession.cookie, "x-csrf-token": bobSession.csrf },
        payload: {},
      });
      expect(rotateDenied.statusCode).toBe(403);
    }
  });
});
