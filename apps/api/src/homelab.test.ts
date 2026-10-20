import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import {
  createCore,
  makeLogger,
  hashPassword,
  keyIdOf,
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
    masterKey: "c".repeat(64),
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

describe("homelab endpoints", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let user: Session;
  let userId: string;
  let vmId: string;

  const calls: string[] = [];
  let taskStatusResult: { status: string; exitstatus?: string } = { status: "stopped", exitstatus: "OK" };
  const fakeProxmox = {
    nextId: async () => 501,
    clone: async () => {
      calls.push("clone");
      return "UPID:clone";
    },
    makeTemplate: async () => {
      calls.push("makeTemplate");
      return "UPID:template";
    },
    migrate: async (...args: unknown[]) => {
      calls.push(`migrate:${JSON.stringify(args.slice(2))}`);
      return "UPID:migrate";
    },
    qemuConfig: async () => ({
      ide2: "local:iso/debian-13.6.0-amd64-netinst.iso,media=cdrom",
      scsi0: "local-lvm:vm-200-disk-0",
    }),
    updateConfig: async (_node: string, _vmid: number, cfg: Record<string, unknown>) => {
      calls.push(`updateConfig:${JSON.stringify(cfg)}`);
      return "";
    },
    start: async () => {
      calls.push("start");
      return "UPID:start";
    },
    shutdown: async () => {
      calls.push("shutdown");
      return "UPID:shutdown";
    },
    reboot: async () => {
      calls.push("reboot");
      return "UPID:reboot";
    },
    rrddata: async () => {
      calls.push("rrddata");
      return [{ time: 123, cpu: 0.1, mem: 100 }];
    },
    waitForTask: async () => undefined,
    clusterFirewallOptions: async () => ({ enable: clusterFirewallOn ? 1 : 0 }),
    setGuestFirewallOptions: async (_n: string, _v: number, opts: unknown) => {
      calls.push(`setGuestFirewallOptions:${JSON.stringify(opts)}`);
      return "";
    },
    guestFirewallRules: async () => guestRules,
    createGuestFirewallRule: async (_n: string, _v: number, rule: Record<string, unknown>) => {
      calls.push("createGuestFirewallRule");
      guestRules.unshift({ pos: 0, ...rule });
      return {};
    },
    deleteGuestFirewallRule: async (_n: string, _v: number, pos: number) => {
      calls.push(`deleteGuestFirewallRule:${pos}`);
      const i = guestRules.findIndex((r) => r.pos === pos);
      if (i >= 0) guestRules.splice(i, 1);
      return {};
    },
    taskStatus: async (...args: unknown[]) => {
      calls.push(`taskStatus:${JSON.stringify(args)}`);
      return taskStatusResult;
    },
  };
  let clusterFirewallOn = true;
  const guestRules: Record<string, unknown>[] = [];

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
    const normal = await ctx.users.create({
      username: "alice",
      passwordHash: await hashPassword("User-Password-1!"),
      roles: ["USER"],
    });
    userId = normal.id;

    const vm = await ctx.vms.create({
      vmid: 301,
      node: "node1",
      name: "lab-vm",
      status: "stopped",
      osType: "linux",
    });
    vmId = vm.id;
    await ctx.vms.setAccess(vmId, userId);
    const ciphertext = ctx.encrypt("vault-pw");
    await ctx.db.query(
      `INSERT INTO guacamole_connections
        (id, vm_id, protocol, hostname, port, username, password_ciphertext, key_id, guac_connection_name, guac_identifier, status)
       VALUES ($1, $2, 'ssh', '127.0.0.1', 1, 'deploy', $3, $4, 'lab-conn', NULL, 'ACTIVE')`,
      ["44444444-4444-4434-8444-444444444444", vmId, ciphertext, keyIdOf(ciphertext)],
    );

    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
    user = await login(app, "alice", "User-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const authA = () => ({ cookie: admin.cookie, "x-csrf-token": admin.csrf });
  const authU = () => ({ cookie: user.cookie, "x-csrf-token": user.csrf });

  it("clones a VM with tracking row, access grant, and audit", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/clone`,
      headers: authA(),
      payload: { name: "lab-vm-copy" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { vm: { id: string; vmid: number; node: string; name: string } };
    expect(body.vm.name).toBe("lab-vm-copy");
    expect(body.vm.vmid).toBe(501);
    expect(calls).toContain("clone");
    // Plain user without vm.create cannot clone.
    const denied = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/clone`,
      headers: authU(),
      payload: { name: "nope" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("converts a stopped VM into a registered template", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/make-template`,
      headers: authA(),
      payload: { name: "lab-template" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { template: { name: string } }).template.name).toBe("lab-template");
    expect(calls).toContain("makeTemplate");
  });

  it("accepts a migration async and finalizes on observed completion", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/migrate`,
      headers: authA(),
      payload: { target: "node2" },
    });
    expect(res.statusCode).toBe(202);
    const started = res.json() as { accepted: boolean; upid: string };
    expect(started.accepted).toBe(true);
    // Tracked node must NOT move until the Proxmox task completes.
    expect((await ctx.vms.requireById(vmId)).node).toBe("node1");
    const statusUrl = (extra: string) =>
      `/api/vms/${vmId}/migration?upid=${encodeURIComponent(started.upid)}&target=node2${extra}`;
    taskStatusResult = { status: "running" };
    const running = await app.inject({ method: "GET", url: statusUrl(""), headers: authA() });
    expect(running.json()).toMatchObject({ state: "running" });
    expect((await ctx.vms.requireById(vmId)).node).toBe("node1");
    taskStatusResult = { status: "stopped", exitstatus: "OK" };
    const done = await app.inject({ method: "GET", url: statusUrl("&online=false"), headers: authA() });
    expect(done.json()).toMatchObject({ state: "done", node: "node2" });
    expect((await ctx.vms.requireById(vmId)).node).toBe("node2");
    // Re-polling after finalization short-circuits to done without Proxmox.
    const again = await app.inject({ method: "GET", url: statusUrl(""), headers: authA() });
    expect(again.json()).toMatchObject({ state: "done" });
    // Same-target migration is rejected up front on POST.
    const same = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/migrate`,
      headers: authA(),
      payload: { target: "node2" },
    });
    expect(same.statusCode).toBe(400);
  });

  it("ejects locally-mounted ISOs and reports migration failure without moving the node", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/migrate`,
      headers: authA(),
      payload: { target: "node3", online: true },
    });
    expect(res.statusCode).toBe(202);
    const started = res.json() as { accepted: boolean; upid: string; detachedIso: string[] };
    expect(started).toMatchObject({ accepted: true, detachedIso: ["ide2"] });
    expect(calls).toContain('updateConfig:{"ide2":"none,media=cdrom"}');
    expect(calls).toContain('migrate:["node3",true,true]');
    taskStatusResult = { status: "stopped", exitstatus: "migration problems" };
    const failed = await app.inject({
      method: "GET",
      url: `/api/vms/${vmId}/migration?upid=${encodeURIComponent(started.upid)}&target=node3&online=true`,
      headers: authA(),
    });
    expect(failed.json()).toMatchObject({ state: "error", exitStatus: "migration problems" });
    expect((await ctx.vms.requireById(vmId)).node).toBe("node2");
    taskStatusResult = { status: "stopped", exitstatus: "OK" };
  });

  it("serves RRD stats with access control", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/vms/${vmId}/stats?timeframe=hour`, headers: authU() });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { points: unknown[] }).points).toHaveLength(1);
    expect(calls).toContain("rrddata");
    const badFrame = await app.inject({ method: "GET", url: `/api/vms/${vmId}/stats?timeframe=decade`, headers: authU() });
    expect(badFrame.statusCode).toBe(400);
  });

  it("bulk actions report per-VM results", async () => {
    // Alice holds no power permissions: whole request denied up front.
    const denied = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authU(),
      payload: { ids: [vmId], action: "start" },
    });
    expect(denied.statusCode).toBe(403);
    // Admin: per-item ok.
    const res = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [vmId, "55555555-5555-4555-8555-555555555555"], action: "start" },
    });
    expect(res.statusCode).toBe(200);
    const results = (res.json() as { results: Array<{ vmId: string; ok: boolean; error?: string }> }).results;
    expect(results.find((r) => r.vmId === vmId)?.ok).toBe(true);
    expect(results.find((r) => r.vmId === "55555555-5555-4555-8555-555555555555")?.ok).toBe(false);
  });

  it("rejects malformed bulk actions and empty id lists up front", async () => {
    const badAction = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [vmId], action: "shutdown-all" },
    });
    expect(badAction.statusCode).toBe(400);
    const emptyIds = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [], action: "privacy" },
    });
    expect(emptyIds.statusCode).toBe(400);
  });

  it("bulk privacy toggles with per-item visibility re-check", async () => {
    // Alice holds no vm.manage: the privacy action is denied up front for her.
    const denied = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authU(),
      payload: { ids: [vmId], action: "privacy" },
    });
    expect(denied.statusCode).toBe(403);
    // Admin flips privacy on while the VM is still visible to him.
    const on = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [vmId], action: "privacy" },
    });
    expect(on.statusCode).toBe(200);
    expect((on.json() as { results: Array<{ ok: boolean; private: boolean }> }).results[0]).toMatchObject({ ok: true, private: true });
    // A granted USER still sees the flagged VM, but the no-grant admin does not.
    const grantedView = await app.inject({ method: "GET", url: `/api/vms/${vmId}`, headers: authU() });
    expect(grantedView.statusCode).toBe(200);
    const adminView = await app.inject({ method: "GET", url: `/api/vms/${vmId}`, headers: authA() });
    expect(adminView.statusCode).toBeGreaterThanOrEqual(400);
    // Re-authorization at execution: the same privacy bulk toggle now fails
    // per item (flag on, admin has no grant) — the entry permission alone
    // must not be enough.
    const again = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [vmId], action: "privacy" },
    });
    expect(again.statusCode).toBe(200);
    const retried = (again.json() as { results: Array<{ ok: boolean; error?: string }> }).results[0]!;
    expect(retried.ok).toBe(false);
    expect(retried.error).toBe("No access to this VM");
    // The flip was still audited while it succeeded.
    const audits = await ctx.db.query<{ event: string }>("SELECT event FROM audit_logs WHERE vm_id = $1 ORDER BY created_at DESC", [vmId]);
    expect(audits.rows.map((r) => r.event)).toContain("PRIVACY_ENABLED");
    // Restore the flag so later tests see the VM.
    await ctx.vms.setPrivacyFlag(vmId, false);
  });

  it("bulk class switch is guarded by enabled schedules", async () => {
    // No schedules: server -> user is allowed, and flipping back is too.
    const first = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [vmId], action: "class" },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { results: Array<{ ok: boolean; vmClass?: string }> }).results[0]).toMatchObject({ ok: true, vmClass: "user" });
    const back = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [vmId], action: "class" },
    });
    expect((back.json() as { results: Array<{ ok: boolean; vmClass?: string }> }).results[0]).toMatchObject({ ok: true, vmClass: "server" });
    // With an enabled schedule, server -> user is refused per item: idle
    // auto-shutdown would fight the scheduled power action.
    const created = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: authA(),
      payload: { vmId, action: "stop", hour: 1, minute: 30, days: "1,2,3,4,5" },
    });
    expect(created.statusCode).toBe(200);
    const guarded = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [vmId], action: "class" },
    });
    expect(guarded.statusCode).toBe(200);
    const guardedItem = (guarded.json() as { results: Array<{ ok: boolean; error?: string }> }).results[0]!;
    expect(guardedItem.ok).toBe(false);
    expect(guardedItem.error).toMatch(/enabled schedules/);
    // Once the schedule is gone the switch works again.
    const schedule = (created.json() as { schedule: { id: string } }).schedule;
    await app.inject({ method: "DELETE", url: `/api/schedules/${schedule.id}`, headers: authA() });
    const after = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [vmId], action: "class" },
    });
    expect((after.json() as { results: Array<{ ok: boolean }> }).results[0]!.ok).toBe(true);
    // Flip back to server for the start-on-boot/isolation tests below.
    await ctx.vms.setVmClass(vmId, "server");
  });

  it("bulk start-on-boot writes the Proxmox onboot flag first", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [vmId], action: "start-on-boot" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { results: Array<{ ok: boolean }> }).results[0]!.ok).toBe(true);
    // Proxmox-first: the onboot config write precedes the DB desired-state write.
    expect(calls).toContain('updateConfig:{"onboot":1}');
    expect((await ctx.vms.requireById(vmId)).startOnBoot).toBe(true);
    const off = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [vmId], action: "start-on-boot" },
    });
    expect((off.json() as { results: Array<{ ok: boolean }> }).results[0]!.ok).toBe(true);
    expect(calls).toContain('updateConfig:{"onboot":0}');
    expect((await ctx.vms.requireById(vmId)).startOnBoot).toBe(false);
  });

  it("bulk isolation applies and removes the guest firewall ruleset", async () => {
    const on = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [vmId], action: "isolation" },
    });
    expect(on.statusCode).toBe(200);
    expect((on.json() as { results: Array<{ ok: boolean }> }).results[0]!.ok).toBe(true);
    expect(calls).toContain('setGuestFirewallOptions:{"enable":true,"policy_in":"DROP","policy_out":"DROP"}');
    expect(calls).toContain("createGuestFirewallRule");
    expect((await ctx.vms.requireById(vmId)).firewallIsolated).toBe(true);
    const off = await app.inject({
      method: "POST",
      url: "/api/vms/bulk-action",
      headers: authA(),
      payload: { ids: [vmId], action: "isolation" },
    });
    expect((off.json() as { results: Array<{ ok: boolean }> }).results[0]!.ok).toBe(true);
    expect(calls).toContain('setGuestFirewallOptions:{"policy_in":"ACCEPT","policy_out":"ACCEPT"}');
    expect((await ctx.vms.requireById(vmId)).firewallIsolated).toBe(false);
    // Guard: with the cluster firewall disabled, guest rules would be silently
    // ignored — the item must fail instead of lying about success.
    clusterFirewallOn = false;
    try {
      const blocked = await app.inject({
        method: "POST",
        url: "/api/vms/bulk-action",
        headers: authA(),
        payload: { ids: [vmId], action: "isolation" },
      });
      const blockedItem = (blocked.json() as { results: Array<{ ok: boolean; error?: string }> }).results[0]!;
      expect(blockedItem.ok).toBe(false);
      expect(blockedItem.error).toMatch(/cluster firewall is disabled/);
    } finally {
      clusterFirewallOn = true;
    }
  });

  it("manages schedules with validation and guards", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: authA(),
      payload: { vmId, action: "stop", hour: 1, minute: 30, days: "1,2,3,4,5" },
    });
    expect(created.statusCode).toBe(200);
    const schedule = (created.json() as { schedule: { id: string } }).schedule;
    const badHour = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: authA(),
      payload: { vmId, action: "stop", hour: 99, minute: 0 },
    });
    expect(badHour.statusCode).toBe(400);
    const list = await app.inject({ method: "GET", url: "/api/schedules", headers: authA() });
    expect((list.json() as { schedules: unknown[] }).schedules).toHaveLength(1);
    const toggle = await app.inject({
      method: "PATCH",
      url: `/api/schedules/${schedule.id}`,
      headers: authA(),
      payload: { enabled: false },
    });
    expect(toggle.statusCode).toBe(200);
    const del = await app.inject({ method: "DELETE", url: `/api/schedules/${schedule.id}`, headers: authA() });
    expect(del.statusCode).toBe(200);
    // Plain user cannot manage schedules.
    const denied = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: authU(),
      payload: { vmId, action: "stop", hour: 1, minute: 0 },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("share links create/list/redeem/revoke with expiry and uses", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/share`,
      headers: authA(),
      payload: { protocol: "ssh", expiresInMinutes: 60, maxUses: 1 },
    });
    expect(created.statusCode).toBe(200);
    const { link, token } = created.json() as { link: { id: string }; token: string };
    expect(typeof token).toBe("string");

    const listed = await app.inject({ method: "GET", url: "/api/share", headers: authA() });
    expect((listed.json() as { links: unknown[] }).links).toHaveLength(1);

    // Redeem with a bogus token: gone, never 500.
    const bogus = await app.inject({ method: "GET", url: "/api/s/does-not-exist" });
    expect(bogus.statusCode).toBe(410);

    // Revoke then redeem: gone.
    const revoked = await app.inject({ method: "DELETE", url: `/api/share/${link.id}`, headers: authA() });
    expect(revoked.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/api/s/${token}` });
    expect(after.statusCode).toBe(410);

    // Plain user without vm.edit cannot create shares.
    const denied = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/share`,
      headers: authU(),
      payload: { protocol: "ssh", expiresInMinutes: 60 },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("discovers services and reads the snapshot", async () => {
    const run = await app.inject({
      method: "POST",
      url: "/api/discovery/run",
      headers: authA(),
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    const summary = await app.inject({ method: "GET", url: "/api/vm-services", headers: authU() });
    expect(summary.statusCode).toBe(200);
  });

  it("exports audit CSV with auth", async () => {
    const csv = await app.inject({ method: "GET", url: "/api/audit/export?limit=5", headers: authA() });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body.split("\n")[0]).toBe("id,created_at,event,actor_username,vm_id,job_id,ip,detail");
    const denied = await app.inject({ method: "GET", url: "/api/audit/export", headers: authU() });
    expect(denied.statusCode).toBe(403);
  });

  it("connection health summary respects visibility", async () => {
    const res = await app.inject({ method: "GET", url: "/api/connection-health", headers: authU() });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray((res.json() as { health: unknown[] }).health)).toBe(true);
  });
});
