// ---------------------------------------------------------------------------
// drift.test.ts — ground-truth drift detection & reconciliation.
// Coverage: pure detectors (positive/negative/boundary/malformed), the
// finding lifecycle (create/bump/auto-resolve/re-open/acknowledge),
// exemptions (active provisioning jobs + unrefined dimensions), the
// orchestrator (fail-open skips, hardware baselining, credential probes
// with cooldown), and remediation (re-verification, stale refusals, audit).
// pg-mem + ioredis-mock; Proxmox/SSH/Guacamole mocks live only at the
// external boundary.
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  hashPassword,
  detectDeletedVms,
  detectConfigDrift,
  detectHardwareDrift,
  detectIpDrift,
  detectOrphanGuac,
  findableResources,
  applyFindings,
  runDriftPass,
  listDriftFindings,
  getDriftLastRun,
  bumpHardwareSnapshot,
  decommissionDriftVm,
  adoptDriftFinding,
  resyncDriftIp,
  deleteOrphanDriftConnection,
  acknowledgeDriftFinding,
  DRIFT_ENABLED_KEY,
  type CoreContext,
  type LocalConfig,
  type DriftLiveResource,
  type DriftActionDeps,
  type DriftPassDeps,
  type ProxmoxClient,
} from "./index.js";

const VM_A = "11111111-1111-4111-8111-111111111111";
const VM_B = "22222222-2222-4222-8222-222222222222";

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
    masterKey: "a".repeat(64),
  },
};

const silentLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as never;

interface VmLiteOverrides {
  id?: string;
  vmid?: number;
  node?: string;
  name?: string;
  status?: string;
  osType?: string;
  osName?: string;
  ipAddress?: string | null;
  ipStatic?: boolean;
}

function vmLite(o: VmLiteOverrides = {}): {
  id: string;
  vmid: number;
  node: string;
  name: string;
  status: string;
  osType: string;
  osName: string;
  ipAddress: string | null;
  ipStatic: boolean;
} {
  return {
    id: o.id ?? VM_A,
    vmid: o.vmid ?? 500,
    node: o.node ?? "node1",
    name: o.name ?? "web",
    status: o.status ?? "running",
    osType: o.osType ?? "linux",
    osName: o.osName ?? "Debian",
    ipAddress: o.ipAddress ?? null,
    ipStatic: o.ipStatic ?? false,
  };
}

const CONNECTION_FAILED: DriftPassDeps["probeSshFn"] = () =>
  Promise.resolve({ status: "CONNECTION_FAILED", detail: "disabled for test" });

describe("findableResources", () => {
  it("excludes templates and keeps qemu guest rows", () => {
    const list = findableResources([
      { vmid: 100, node: "n1", name: "tmpl", status: "stopped", template: 1 },
      { vmid: 101, node: "n1", name: "web", status: "running", template: 0 },
      { vmid: 102, node: "n2", name: "db", status: "stopped", template: 0 },
    ]);
    expect(list.map((r) => r.vmid)).toEqual([101, 102]);
  });

  it("drops malformed and non-array input instead of throwing", () => {
    expect(findableResources(null)).toEqual([]);
    expect(findableResources([{ garbage: true } as never])).toEqual([]);
  });
});

describe("pure detectors", () => {
  const LIVE: DriftLiveResource[] = [
    { vmid: 500, node: "node1", name: "web", status: "running" },
    { vmid: 501, node: "node1", name: "db", status: "running" },
  ];

  describe("detectDeletedVms", () => {
    it("flags recorded vmids absent from the live list with a stable fingerprint", () => {
      const out = detectDeletedVms([vmLite({ vmid: 604 })], LIVE);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ fingerprint: `deleted:${VM_A}`, dimension: "deleted", vmId: VM_A });
    });

    it("stays silent when every record still exists or the list is empty", () => {
      expect(detectDeletedVms([vmLite({ id: VM_B, vmid: 501, name: "db" })], LIVE)).toHaveLength(0);
      expect(detectDeletedVms([], LIVE)).toHaveLength(0);
    });
  });

  describe("detectConfigDrift", () => {
    it("flags case-distinct renames and node moves independently", () => {
      const out = detectConfigDrift([vmLite()], [
        { vmid: 500, node: "n2", name: "webserver", status: "running" },
      ]);
      expect(out.map((f) => f.fingerprint)).toEqual([`config:${VM_A}:name`, `config:${VM_A}:node`]);
    });

    it("ignores case-only name differences (Proxmox lowercases resource names)", () => {
      expect(detectConfigDrift([vmLite()], [{ vmid: 500, node: "node1", name: "WEB", status: "running" }])).toHaveLength(0);
    });

    it("stays silent on identical state and skips guests missing from live", () => {
      expect(detectConfigDrift([vmLite()], LIVE)).toHaveLength(0);
      expect(detectConfigDrift([vmLite({ vmid: 604 })], LIVE)).toHaveLength(0);
    });
  });

  describe("detectHardwareDrift", () => {
    const liveHw = { cores: 4, memory: 8192, net: [{ model: "virtio", macaddr: "AA:BB:CC:DD:EE:FF" }] };

    it("never flags the first sighting (no stored baseline)", () => {
      expect(detectHardwareDrift(VM_A, "web", null, liveHw)).toHaveLength(0);
    });

    it("flags each changed field with its own fingerprint", () => {
      const out = detectHardwareDrift(VM_A, "web", { cores: 2, memoryMb: 4096, net: null }, liveHw);
      expect(out.map((f) => f.fingerprint).sort()).toEqual([
        `hw:${VM_A}:cores`,
        `hw:${VM_A}:memoryMb`,
        `hw:${VM_A}:net`,
      ]);
      expect(out[0]?.detail).toMatchObject({ field: "cores", recorded: 2, live: 4 });
    });

    it("stays silent when values match (incl. canonical net equality)", () => {
      expect(
        detectHardwareDrift(VM_A, "web", { cores: 4, memoryMb: 8192, net: JSON.stringify(liveHw.net) }, liveHw),
      ).toHaveLength(0);
    });

    it("treats a partial baseline (null cores) as a first sighting", () => {
      expect(detectHardwareDrift(VM_A, "web", { cores: null, memoryMb: 4096, net: null }, liveHw)).toHaveLength(0);
    });
  });

  describe("detectIpDrift", () => {
    it("flags a DHCP address change with recorded/live detail", () => {
      const out = detectIpDrift({ id: VM_A, name: "web", ipAddress: "10.0.0.5", ipStatic: false }, "10.0.0.9");
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ dimension: "ip", detail: { recorded: "10.0.0.5", live: "10.0.0.9" } });
    });

    it("ignores static addresses, missing values, and unchanged ips", () => {
      expect(detectIpDrift({ id: VM_A, name: "web", ipAddress: "10.0.0.5", ipStatic: true }, "10.0.0.9")).toHaveLength(0);
      expect(detectIpDrift({ id: VM_A, name: "web", ipAddress: null, ipStatic: false }, "10.0.0.9")).toHaveLength(0);
      expect(detectIpDrift({ id: VM_A, name: "web", ipAddress: "10.0.0.5", ipStatic: false }, null)).toHaveLength(0);
      expect(detectIpDrift({ id: VM_A, name: "web", ipAddress: "10.0.0.5", ipStatic: false }, "10.0.0.5")).toHaveLength(0);
    });
  });

  describe("detectOrphanGuac", () => {
    it("flags records whose vm is gone and skips connections of live vms", () => {
      const out = detectOrphanGuac(
        [
          { id: "c1", vm_id: VM_A, guac_connection_name: "proxvm-web-ssh" },
          { id: "c2", vm_id: VM_B, guac_connection_name: "proxvm-ghost-ssh" },
        ],
        new Set([VM_A]),
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ dimension: "guac", connectionId: "c2", vmId: VM_B });
    });
  });
});

describe("applyFindings lifecycle", () => {
  let ctx: CoreContext;
  let pool: Pool;
  let cleanup: () => Promise<void>;
  let vmId: string;
  let n = 0;
  const ticks = () => new Date(Date.now() + ++n * 10_000);

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    pool = new MemPool() as unknown as Pool;
    cleanup = async () => pool.end().catch(() => undefined);
    ctx = await createCore(localConfig, { db: pool, redis: new RedisMock() as never, logger: silentLogger });
    const vm = await ctx.vms.create({ vmid: 410, node: "node1", name: "lifecycle-vm", status: "running", osType: "linux" });
    vmId = vm.id;
  });

  afterAll(async () => cleanup());

  beforeEach(async () => {
    await pool.query("DELETE FROM drift_findings");
  });

  const finding = () => ({
    fingerprint: `config:${vmId}:name`,
    dimension: "config" as const,
    severity: "low" as const,
    vmId,
    title: "renamed",
    summary: "was renamed",
    detail: { field: "name" },
  });

  it("creates OPEN once and bumps without duplicating", async () => {
    const first = await applyFindings(pool, [finding()], { now: ticks() });
    expect(first).toMatchObject({ created: 1, updated: 0, resolved: 0 });
    expect(first.newFingerprints).toContain(`config:${vmId}:name`);
    const again = await applyFindings(pool, [finding()], { now: ticks() });
    expect(again).toMatchObject({ created: 0, updated: 1 });
    const rows = await listDriftFindings(pool, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "OPEN", occurrences: 1, dimension: "config" });
  });

  it("bumps refresh summary/detail while keeping first_seen identity", async () => {
    await applyFindings(pool, [finding()], { now: ticks() });
    const first = await pool.query<{ first_seen: Date }>("SELECT first_seen FROM drift_findings");
    await applyFindings(pool, [{ ...finding(), summary: "was renamed (still)" }], { now: ticks() });
    const second = await pool.query<{ first_seen: Date }>("SELECT first_seen FROM drift_findings");
    expect(second.rows[0]!.first_seen.getTime()).toBe(first.rows[0]!.first_seen.getTime());
    expect((await listDriftFindings(pool, {}))[0]?.summary).toBe("was renamed (still)");
  });

  it("auto-resolves when the finding stops reproducing", async () => {
    await applyFindings(pool, [finding()], { now: ticks() });
    const result = await applyFindings(pool, [], { now: ticks() });
    expect(result.resolved).toBe(1);
    expect(await listDriftFindings(pool, {})).toHaveLength(0);
  });

  it("re-opens a resolved row with occurrences+1 and cleared resolution stamps", async () => {
    await applyFindings(pool, [finding()], { now: ticks() });
    await applyFindings(pool, [], { now: ticks() });
    const reopened = await applyFindings(pool, [finding()], { now: ticks() });
    expect(reopened).toMatchObject({ created: 0, updated: 1 }); // same row re-opened
    const row = await pool.query<{ status: string; occurrences: number; resolved_at: Date | null }>(
      "SELECT status, occurrences, resolved_at FROM drift_findings",
    );
    expect(row.rows[0]).toMatchObject({ status: "OPEN", occurrences: 2 });
    expect(row.rows[0]!.resolved_at).toBeNull();
  });

  it("is idempotent: repeated absence resolves nothing further", async () => {
    await applyFindings(pool, [finding()], { now: ticks() });
    expect((await applyFindings(pool, [], { now: ticks() })).resolved).toBe(1);
    expect((await applyFindings(pool, [], { now: ticks() })).resolved).toBe(0);
  });

  it("exempt VMs are preserved from auto-resolve, non-exempt are not", async () => {
    const other = await ctx.vms.create({ vmid: 411, node: "node1", name: "exempt-vm", status: "running", osType: "linux" });
    await applyFindings(pool, [finding(), { ...finding(), fingerprint: `deleted:${other.id}`, dimension: "deleted", vmId: other.id }], { now: ticks() });
    await applyFindings(pool, [], { now: ticks(), exemptVmIds: new Set([other.id]) });
    const rows = await listDriftFindings(pool, {});
    expect(rows.map((r) => r.fingerprint)).toEqual([`deleted:${other.id}`]);
  });

  it("unrefined ip findings are preserved; non-reproducing config findings are not", async () => {
    await applyFindings(
      pool,
      [
        { ...finding(), fingerprint: `ip:${vmId}`, dimension: "ip" },
        { ...finding(), fingerprint: `config:${vmId}:node`, detail: { field: "node" } },
      ],
      { now: ticks() },
    );
    // No output this pass; the ip dimension's check could not run for the VM.
    await applyFindings(pool, [], { now: ticks(), unrefinedVmIds: new Set([vmId]) });
    const rows = await listDriftFindings(pool, {});
    expect(rows.map((r) => r.fingerprint)).toEqual([`ip:${vmId}`]);
  });

  it("resolveStale:false (internal single-finding callers) never auto-resolves others", async () => {
    await applyFindings(pool, [finding()], { now: ticks() });
    await applyFindings(pool, [{ ...finding(), fingerprint: `hw:${vmId}:cores`, dimension: "hw" }], { now: ticks(), resolveStale: false });
    expect(await listDriftFindings(pool, {})).toHaveLength(2);
  });
});

describe("drift orchestrator", () => {
  let ctx: CoreContext;
  let pool: Pool;
  let cleanup: () => Promise<void>;
  let vmId: string;
  // Live cluster view; tests mutate this per scenario.
  const liveResources: DriftLiveResource[] = [];

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    pool = new MemPool() as unknown as Pool;
    cleanup = async () => pool.end().catch(() => undefined);
    ctx = await createCore(localConfig, { db: pool, redis: new RedisMock() as never, logger: silentLogger });
    const vm = await ctx.vms.create({ vmid: 700, node: "node1", name: "drift-vm", status: "running", osType: "linux" });
    vmId = vm.id;
    await ctx.vms.updateIp(vmId, "10.0.0.50", { static: false });
    liveResources.push({ vmid: 700, node: "node1", name: "drift-vm", status: "running" });
  });

  afterAll(async () => cleanup());

  interface ClientOverrides {
    resources?: DriftLiveResource[];
    config?: { cores: number; memory: number; net: Array<Record<string, unknown>> | null };
    agent?: { ipv4s: string[] } | null;
    fail?: boolean;
  }

  function fakeClient(o: ClientOverrides = {}): ProxmoxClient {
    return {
      clusterResources: async () => {
        if (o.fail) throw new Error("cluster is down");
        return (o.resources ?? liveResources).map((r) => ({ ...r, template: 0, maxcpu: 1, cpu: 1, mem: 1, maxmem: 1, maxdisk: 1, disk: 1, uptime: 1, netin: 1, netout: 1 }));
      },
      qemuConfig: async () => o.config ?? { cores: 2, memory: 4096, net: null },
      guestIpAddresses: async () => (o.agent === undefined ? { ipv4s: ["10.0.0.50"] } : o.agent),
    } as unknown as ProxmoxClient;
  }

  function passDeps(client: ProxmoxClient, o: Partial<DriftPassDeps> = {}): DriftPassDeps {
    return {
      db: ctx.db,
      settings: ctx.settings,
      vms: ctx.vms,
      jobs: ctx.jobs,
      guac: ctx.guac,
      creds: ctx.creds,
      hostKeys: ctx.hostKeys,
      decrypt: ctx.decrypt,
      getProxmoxClient: async () => client,
      logger: ctx.logger,
      probeSshFn: CONNECTION_FAILED,
      ...o,
    };
  }

  beforeEach(async () => {
    await pool.query("DELETE FROM drift_findings");
    await pool.query("DELETE FROM drift_vm_state");
    await pool.query("DELETE FROM provisioning_jobs");
    await pool.query("DELETE FROM guacamole_connections");
  });

  it("skips cleanly when Proxmox is not configured (fail-open)", async () => {
    const result = await runDriftPass({ ...passDeps(fakeClient()), getProxmoxClient: ctx.getProxmoxClient });
    expect(result).toMatchObject({ skipped: "unconfigured", liveChecked: false, created: 0 });
  });

  it("fails open when Proxmox is unreachable", async () => {
    const result = await runDriftPass(passDeps(fakeClient({ fail: true })));
    expect(result).toMatchObject({ skipped: "proxmox_down", liveChecked: false });
  });

  it("skips when the feature is disabled via settings", async () => {
    await ctx.settings.set(DRIFT_ENABLED_KEY, "false", { category: "system" });
    const result = await runDriftPass(passDeps(fakeClient()));
    expect(result.skipped).toBe("disabled");
    await ctx.settings.set(DRIFT_ENABLED_KEY, "true", { category: "system" });
  });

  it("first pass baselines hardware without false findings; second pass flags changes", async () => {
    const first = await runDriftPass(passDeps(fakeClient()));
    expect(first.skipped).toBeNull();
    expect(first.created).toBe(0);
    const state = await pool.query<{ cores: number; memory_mb: number }>(
      "SELECT cores, memory_mb FROM drift_vm_state WHERE vm_id = $1",
      [vmId],
    );
    expect(state.rows[0]).toMatchObject({ cores: 2, memory_mb: 4096 });

    const second = await runDriftPass(passDeps(fakeClient({ config: { cores: 2, memory: 8192, net: null } })));
    expect(second.created).toBe(1); // hw:...:memoryMb only
    expect(second.resolved).toBe(0);
    const rows = await listDriftFindings(pool, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dimension: "hw", fingerprint: `hw:${vmId}:memoryMb` });
  });

  it("exempts VMs with active provisioning jobs from every per-VM comparison", async () => {
    const first = await runDriftPass(passDeps(fakeClient({ config: { cores: 9, memory: 9999, net: null }, agent: { ipv4s: ["10.0.0.77"] } })));
    expect(first.exempted).toBe(0);
    await ctx.jobs.create({ vmId, request: {}, createdByUserId: null });
    const second = await runDriftPass(passDeps(fakeClient({ config: { cores: 8, memory: 8888, net: null }, agent: { ipv4s: ["10.0.0.88"] } })));
    expect(second.exempted).toBe(1);
    // No new findings for the exempt VM — its conflicts were invisible.
    expect(second.created).toBe(0);
  });

  it("flags out-of-band deletion and orphaned guac records in the same pass", async () => {
    // A soft-deleted VM keeps its guac record: exactly the real orphan case.
    let ghostId = "";
    {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO vms (id, vmid, node, name, status, os_type, deleted_at) VALUES ($1,$2,$3,$4,'running','linux',NOW()) RETURNING id`,
        [VM_B, 701, "node1", "ghost", ""],
      );
      ghostId = result.rows[0]!.id;
      await pool.query(
        `INSERT INTO guacamole_connections (id, vm_id, protocol, hostname, port, username, password_ciphertext, key_id, guac_connection_name)
         VALUES ($1,$2,'ssh','10.0.0.99',22,'me','enc','v1','proxvm-ghost-ssh')`,
        ["33333333-3333-4333-8333-333333333333", ghostId],
      );
    }
    const ghostRemoved: DriftLiveResource[] = [{ vmid: 999, node: "node1", name: "web", status: "running" }];
    const result = await runDriftPass(passDeps(fakeClient({ resources: ghostRemoved })));
    expect(result.skipped).toBeNull();
    const fingerprints = (await listDriftFindings(pool, {})).map((f) => f.fingerprint);
    expect(fingerprints).toContain(`deleted:${vmId}`);
    const orphan = fingerprints.find((f) => f.startsWith("guac:"));
    expect(orphan).toBeDefined();
    const lastRun = await getDriftLastRun(ctx.settings);
    expect(lastRun).toMatchObject({ liveChecked: true, created: 2 });
  });

  it("auto-resolves deletions and stale orphans once the discrepancy is gone", async () => {
    const pass1 = await runDriftPass(passDeps(fakeClient({ resources: [{ vmid: 999, node: "node1", name: "web", status: "running" }] })));
    expect(pass1.created).toBe(1); // deleted:<vmId>
    expect((await listDriftFindings(pool, {})).map((f) => f.fingerprint)).toContain(`deleted:${vmId}`);

    // Guest is back under the same vmid -> the deletion finding auto-resolves.
    const pass2 = await runDriftPass(passDeps(fakeClient()));
    expect(pass2).toMatchObject({ resolved: 1, created: 0 });
    expect(await listDriftFindings(pool, {})).toHaveLength(0);
  });

  it("reports IP drift and preserves (not resolves) it when the agent goes silent", async () => {
    const pass1 = await runDriftPass(passDeps(fakeClient({ agent: { ipv4s: ["10.0.0.99"] } })));
    expect(pass1.created).toBe(1);
    const openIps = (await listDriftFindings(pool, {})).filter((f) => f.dimension === "ip");
    expect(openIps).toHaveLength(1);
    expect(openIps[0]).toMatchObject({ status: "OPEN", fingerprint: `ip:${vmId}` });

    const pass2 = await runDriftPass(passDeps(fakeClient({ agent: null })));
    expect(pass2.resolved).toBe(0);
    expect((await listDriftFindings(pool, {})).filter((f) => f.dimension === "ip")).toHaveLength(1);
  });
});

describe("credential drift probe", () => {
  let ctx: CoreContext;
  let pool: Pool;
  let cleanup: () => Promise<void>;
  let vmId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    pool = new MemPool() as unknown as Pool;
    cleanup = async () => pool.end().catch(() => undefined);
    ctx = await createCore(localConfig, { db: pool, redis: new RedisMock() as never, logger: silentLogger });
    const vm = await ctx.vms.create({ vmid: 800, node: "node1", name: "probe-vm", status: "running", osType: "linux" });
    vmId = vm.id;
    await ctx.vms.updateIp(vmId, "10.0.0.80", { static: false });
    await ctx.creds.store(vmId, "deployer", "Password-Test-1");
  });

  afterAll(async () => cleanup());

  beforeEach(async () => {
    await pool.query("DELETE FROM drift_findings");
    await pool.query("DELETE FROM drift_vm_state");
  });

  function deps(probe: DriftPassDeps["probeSshFn"]): DriftPassDeps {
    return {
      db: ctx.db,
      settings: ctx.settings,
      vms: ctx.vms,
      jobs: ctx.jobs,
      guac: ctx.guac,
      creds: ctx.creds,
      hostKeys: ctx.hostKeys,
      decrypt: ctx.decrypt,
      getProxmoxClient: async () =>
        ({
          clusterResources: async () => [{ vmid: 800, node: "node1", name: "probe-vm", status: "running", template: 0 }],
          qemuConfig: async () => ({ cores: 1, memory: 1024, net: null }),
          guestIpAddresses: async () => ({ ipv4s: ["10.0.0.80"] }),
        }) as unknown as ProxmoxClient,
      logger: ctx.logger,
      probeSshFn: probe,
    };
  }

  it("produces a credential finding on AUTH_FAILED; the cooldown then suppresses re-probes", async () => {
    const first = await runDriftPass(deps(() => Promise.resolve({ status: "AUTH_FAILED", detail: "password rejected" })));
    expect(first.created).toBe(1);
    const rows = await listDriftFindings(pool, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dimension: "credential", status: "OPEN", vmId });
    expect(rows[0]!.summary).not.toContain("Password-Test-1");

    const second = await runDriftPass(
      deps(() => {
        throw new Error("must not probe inside the cooldown window");
      }),
    );
    expect(second.created).toBe(0);
  });

  it("marks VERIFIED on AUTHENTICATED without creating findings", async () => {
    const result = await runDriftPass(deps(() => Promise.resolve({ status: "AUTHENTICATED", detail: "ok", output: "host" })));
    expect(result.created).toBe(0);
    const cred = await ctx.creds.findByVm(vmId);
    expect(cred?.status).toBe("VERIFIED");
  });

  it("does not probe non-linux guests (v1 scope) and leaves no findings", async () => {
    await pool.query("UPDATE vms SET os_type = 'windows' WHERE id = $1", [vmId]);
    try {
      const result = await runDriftPass(
        deps(() => {
          throw new Error("windows must not be probed in v1");
        }),
      );
      expect(result.created).toBe(0);
      expect(await listDriftFindings(pool, {})).toHaveLength(0);
    } finally {
      await pool.query("UPDATE vms SET os_type = 'linux' WHERE id = $1", [vmId]);
    }
  });
});

describe("remediation", () => {
  let ctx: CoreContext;
  let pool: Pool;
  let cleanup: () => Promise<void>;
  let vmId: string;
  let actor: { userId: string; username: string };
  let audits: Array<{ event: string; detail: Record<string, unknown> }>;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    pool = new MemPool() as unknown as Pool;
    cleanup = async () => pool.end().catch(() => undefined);
    ctx = await createCore(localConfig, { db: pool, redis: new RedisMock() as never, logger: silentLogger });
    const vm = await ctx.vms.create({ vmid: 900, node: "node1", name: "fix-vm", status: "running", osType: "linux" });
    vmId = vm.id;
    await ctx.vms.updateIp(vmId, "10.0.0.90", { static: false });
    // Remediations stamp acknowledged_by/remediated_by (users FK): create a
    // real user instead of a fabricated admin UUID.
    const user = await ctx.users.create({
      username: "drift-admin",
      passwordHash: await hashPassword("Drift-Password-1"),
      roles: ["ADMIN"],
    });
    actor = { userId: user.id, username: user.username };
  });

  afterAll(async () => cleanup());

  beforeEach(async () => {
    await pool.query("DELETE FROM drift_findings");
    await pool.query("DELETE FROM provisioning_jobs");
    await pool.query("DELETE FROM guacamole_connections");
    // The decommission happy-path soft-deletes the fixture; restore it so
    // every test starts from a live record at the fixture IP.
    await pool.query("UPDATE vms SET deleted_at = NULL, ip_address = '10.0.0.90' WHERE id = $1", [vmId]);
    audits = [];
  });

  function actionDeps(o: { resources?: unknown; agent?: { ipv4s: string[] } | null } = {}): DriftActionDeps {
    return {
      db: ctx.db,
      vms: ctx.vms,
      jobs: ctx.jobs,
      guac: ctx.guac,
      hostKeys: ctx.hostKeys,
      audit: async (entry) => {
        audits.push({ event: entry.event as string, detail: (entry.detail ?? {}) as Record<string, unknown> });
      },
      decrypt: ctx.decrypt,
      getProxmoxClient: async () =>
        ({
          clusterResources: async () => o.resources ?? [],
          qemuConfig: async () => ({ cores: 2, memory: 2048, net: null }),
          guestIpAddresses: async () => o.agent ?? null,
        }) as unknown as ProxmoxClient,
      getGuacDb: async () => ({ deleteConnection: async () => undefined }) as never,
      logger: ctx.logger,
    };
  }

  const seed = async (partial: Partial<Parameters<typeof applyFindings>[1][number]>) => {
    await applyFindings(
      ctx.db,
      [{ fingerprint: "seed", dimension: "config", severity: "low", vmId, title: "t", summary: "s", ...partial }],
      { now: new Date(), resolveStale: false }, // seeding must not auto-resolve sibling findings
    );
    return (await listDriftFindings(ctx.db, {}))[0]!;
  };

  it("decommission soft-deletes the record, resolves the finding, and audits redacted", async () => {
    const finding = await seed({ fingerprint: `deleted:${vmId}`, dimension: "deleted", severity: "high" });
    const out = await decommissionDriftVm(actionDeps(), finding.id, actor);
    expect(out).toEqual({ resolved: true, action: "decommission" });
    expect(await ctx.vms.findById(vmId)).toBeNull();
    expect(await listDriftFindings(ctx.db, {})).toHaveLength(0);
    const audit = audits.find((a) => a.event === "DRIFT_REMEDIATED")!;
    expect(audit.detail).toMatchObject({ action: "decommission", vmId, vmName: "fix-vm" });
    expect(JSON.stringify(audits)).not.toMatch(/password/i);
  });

  it("decommission refuses when the guest reappeared (stale) or a job is active", async () => {
    const finding = await seed({ fingerprint: `deleted:${vmId}`, dimension: "deleted", severity: "high" });
    await expect(
      decommissionDriftVm(
        actionDeps({ resources: [{ vmid: 900, node: "node1", name: "fix-vm", status: "stopped", template: 0 }] }),
        finding.id,
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await ctx.jobs.create({ vmId, request: {}, createdByUserId: null });
    await expect(decommissionDriftVm(actionDeps(), finding.id, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await pool.query("SELECT id FROM vms WHERE id = $1", [vmId]).then((r) => r.rows.length)).toBe(1); // still live
  });

  it("adopt syncs node moves, resolves, and audits", async () => {
    const finding = await seed({ fingerprint: `config:${vmId}:node`, detail: { field: "node" } });
    const out = await adoptDriftFinding(
      actionDeps({ resources: [{ vmid: 900, node: "node2", name: "fix-vm", status: "running", template: 0 }] }),
      finding.id,
      actor,
    );
    expect(out.action).toBe("adopt");
    expect((await ctx.vms.findById(vmId))?.node).toBe("node2");
    expect(await listDriftFindings(ctx.db, {})).toHaveLength(0);
    expect(audits.some((a) => a.event === "DRIFT_REMEDIATED")).toBe(true);
  });

  it("adopt on hardware records the live qemuConfig as the baseline", async () => {
    const finding = await seed({ fingerprint: `hw:${vmId}:cores`, dimension: "hw", detail: { field: "cores" } });
    await adoptDriftFinding(
      actionDeps({ resources: [{ vmid: 900, node: "node1", name: "fix-vm", status: "running", template: 0 }] }),
      finding.id,
      actor,
    );
    const state = await pool.query<{ cores: number }>("SELECT cores FROM drift_vm_state WHERE vm_id = $1", [vmId]);
    expect(state.rows[0]?.cores).toBe(2);
    expect(await listDriftFindings(ctx.db, {})).toHaveLength(0);
  });

  it("adopt refuses wrong dimensions and resolved findings", async () => {
    const ipFinding = await seed({ fingerprint: `ip:${vmId}`, dimension: "ip" });
    await expect(adoptDriftFinding(actionDeps(), ipFinding.id, actor)).rejects.toMatchObject({ code: "CONFLICT" });

    const finding = await seed({ fingerprint: `config:${vmId}:name`, detail: { field: "name" } });
    await ctx.db.query("UPDATE drift_findings SET status = 'RESOLVED' WHERE id = $1", [finding.id]);
    await expect(adoptDriftFinding(actionDeps(), finding.id, actor)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("resync updates the IP and audits the transition without secrets", async () => {
    const finding = await seed({ fingerprint: `ip:${vmId}`, dimension: "ip", detail: { recorded: "10.0.0.90", live: "10.0.0.91" } });
    const out = await resyncDriftIp(actionDeps({ agent: { ipv4s: ["10.0.0.91"] } }), finding.id, actor);
    expect(out).toMatchObject({ resolved: true, action: "resync_ip", ip: "10.0.0.91" });
    expect((await ctx.vms.findById(vmId))?.ipAddress).toBe("10.0.0.91");
    expect(await listDriftFindings(ctx.db, {})).toHaveLength(0);
    const audit = audits.find((a) => a.event === "DRIFT_REMEDIATED")!;
    expect(audit.detail).toMatchObject({ action: "resync_ip", from: "10.0.0.90", to: "10.0.0.91" });
    expect(JSON.stringify(audits)).not.toMatch(/password/i);
  });

  it("resync refuses when the agent cannot provide an address", async () => {
    const finding = await seed({ fingerprint: `ip:${vmId}`, dimension: "ip" });
    await expect(resyncDriftIp(actionDeps({ agent: null }), finding.id, actor)).rejects.toMatchObject({ code: "EXTERNAL_SERVICE_ERROR" });
  });

  it("resync without a change resolves the finding without rewriting the record", async () => {
    const finding = await seed({ fingerprint: `ip:${vmId}`, dimension: "ip", detail: { recorded: "10.0.0.90", live: "10.0.0.90" } });
    const out = await resyncDriftIp(actionDeps({ agent: { ipv4s: ["10.0.0.90"] } }), finding.id, actor);
    expect(out.resolved).toBe(true);
    expect(audits.find((a) => a.event === "DRIFT_REMEDIATED")?.detail).toMatchObject({ note: "already_correct" });
  });

  it("delete orphan removes the record, resolves, and audits", async () => {
    // Real orphan shape: soft-deleted VM whose connection record lingers.
    // Inline literals: pg-mem will not bind text params into uuid columns.
    const ghost = await pool.query<{ id: string }>(
      "INSERT INTO vms (id, vmid, node, name, status, os_type, deleted_at) VALUES ('55555555-5555-4555-8555-555555555555',901,'node1','ghost2','running','linux',NOW()) RETURNING id",
    );
    const recordId = "44444444-4444-4444-8444-444444444444";
    await ctx.db.query(
      `INSERT INTO guacamole_connections
         VALUES ('44444444-4444-4444-8444-444444444444', (SELECT id FROM vms WHERE vmid = 901 AND deleted_at IS NOT NULL), 'ssh', 'h', 22, 'u', 'enc', 'v1', 'proxvm-orphan-ssh', NULL, 'PENDING', NULL, NOW(), NOW())`,
    );
    const finding = await seed({ fingerprint: `guac:${recordId}`, dimension: "guac", connectionId: recordId, vmId: ghost.rows[0]!.id });
    // Live-VM findings are stale for this action (no dest record touch).
    const liveSeeded = await seed({ fingerprint: `guac:live-record`, dimension: "guac", connectionId: "live-record", vmId });
    await expect(deleteOrphanDriftConnection(actionDeps(), liveSeeded.id, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    const untouched = await ctx.db.query("SELECT id FROM guacamole_connections WHERE id = $1", [recordId]);
    expect(untouched.rows).toHaveLength(1); // conflict must not have deleted anything

    const out = await deleteOrphanDriftConnection(actionDeps(), finding.id, actor);
    expect(out.action).toBe("delete_orphan_connection");
    const gone = await ctx.db.query("SELECT id FROM guacamole_connections WHERE id = $1", [recordId]);
    expect(gone.rows).toHaveLength(0);
    // Only the deliberately-seeded live-VM finding remains active.
    const remaining = await listDriftFindings(ctx.db, {});
    expect(remaining.map((f) => f.fingerprint)).toEqual(["guac:live-record"]);
  });

  it("acknowledge is idempotent, audited once, and auto-resolves when drift disappears", async () => {
    const finding = await seed({ fingerprint: `config:${vmId}:os`, detail: { field: "name" } });
    await acknowledgeDriftFinding(actionDeps(), finding.id, actor);
    let status = await pool.query<{ status: string; acknowledged_by: string | null }>("SELECT status, acknowledged_by FROM drift_findings WHERE id = $1", [finding.id]);
    expect(status.rows[0]).toMatchObject({ status: "ACKNOWLEDGED", acknowledged_by: actor.userId });

    await acknowledgeDriftFinding(actionDeps(), finding.id, actor);
    expect(audits.filter((a) => a.event === "DRIFT_FINDING_ACKNOWLEDGED")).toHaveLength(1);

    await applyFindings(ctx.db, [], { now: new Date() });
    status = await pool.query<{ status: string; acknowledged_by: string | null }>("SELECT status FROM drift_findings WHERE id = $1", [finding.id]);
    expect(status.rows[0]?.status).toBe("RESOLVED");
    expect(await listDriftFindings(ctx.db, {})).toHaveLength(0);
  });
});

describe("bumpHardwareSnapshot (in-band edit support)", () => {
  let ctx: CoreContext;
  let pool: Pool;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    pool = new MemPool() as unknown as Pool;
    cleanup = async () => pool.end().catch(() => undefined);
    ctx = await createCore(localConfig, { db: pool, redis: new RedisMock() as never, logger: silentLogger });
  });

  afterAll(async () => cleanup());

  it("upserts the baseline idempotently for the edit route's write-after-accept", async () => {
    const vm = await ctx.vms.create({ vmid: 950, node: "n", name: "bump-vm", status: "running", osType: "linux" });
    await bumpHardwareSnapshot(ctx.db, vm.id, { cores: 8, memory: 16384, net: [{ model: "virtio" }] });
    const row = await pool.query<{ cores: number; memory_mb: number; net_json: string }>(
      "SELECT cores, memory_mb, net_json FROM drift_vm_state WHERE vm_id = $1",
      [vm.id],
    );
    expect(row.rows[0]).toMatchObject({ cores: 8, memory_mb: 16384, net_json: JSON.stringify([{ model: "virtio" }]) });
    await bumpHardwareSnapshot(ctx.db, vm.id, { cores: 9, memory: 16384, net: null });
    const count = await pool.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM drift_vm_state WHERE vm_id = $1", [vm.id]);
    expect(count.rows[0]?.c).toBe("1");
  });
});
