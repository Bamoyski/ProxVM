import { describe, expect, it, beforeAll } from "vitest";
import { newDb } from "pg-mem";
import RedisMock from "ioredis-mock";
import { Pool } from "pg";
import {
  createCore,
  runProvisioningJob,
  type CoreContext,
  type LocalConfig,
} from "./index.js";

const masterKey = "a".repeat(64);
let testCtx: CoreContext;

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

describe("services (pg-mem)", () => {
  let ctx: CoreContext;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMock() as never,
      logger: silentLogger(),
    });
    testCtx = ctx;
  });

  it("settings: encrypts secret values transparently", async () => {
    await ctx.settings.set("proxmox.token_secret", "super-secret-token", { encrypted: true, category: "infrastructure" });
    const raw = await ctx.db.query<{ value: string }>("SELECT value FROM settings WHERE key = 'proxmox.token_secret'");
    expect(raw.rows[0]?.value).not.toContain("super-secret-token");
    expect(await ctx.settings.getPlain("proxmox.token_secret")).toBe("super-secret-token");
  });

  it("credentials: store/rotate/verify lifecycle", async () => {
    const vm = await ctx.vms.create({ vmid: 101, node: "pve1", name: "test-vm" });
    await ctx.creds.store(vm.id, "deploy", "First-Password-1!", "ENCRYPTED");
    const view1 = await ctx.creds.view(vm.id);
    expect(view1?.status).toBe("ENCRYPTED");
    const raw1 = await ctx.db.query<{ password_ciphertext: string }>("SELECT password_ciphertext FROM vm_credentials WHERE vm_id = $1", [vm.id]);
    expect(raw1.rows[0]?.password_ciphertext).not.toContain("First-Password-1!");
    await ctx.creds.rotate(vm.id, "deploy", "Second-Password-2!");
    await ctx.creds.markRotatedSuccess(vm.id);
    const view2 = await ctx.creds.view(vm.id);
    expect(view2?.status).toBe("VERIFIED");
  });

  it("templates: registration is idempotent per node+vmid", async () => {
    const t1 = await ctx.templates.register({
      name: "ubuntu-2404", node: "pve1", proxmoxVmid: 9000, osType: "linux",
      provisioningMethod: "cloud-init", cloudInitSupport: true, guestAgentRequired: true,
      defaultCpu: 2, defaultRamMb: 2048, defaultDiskGb: 20, supportedProtocols: ["ssh"],
    });
    const t2 = await ctx.templates.register({
      name: "ubuntu-2404", node: "pve1", proxmoxVmid: 9000, osType: "linux",
      provisioningMethod: "cloud-init", cloudInitSupport: true, guestAgentRequired: true,
      defaultCpu: 4, defaultRamMb: 4096, defaultDiskGb: 32, supportedProtocols: ["ssh"],
    });
    expect(t1.id).toBe(t2.id);
  });

  it("windows templates without cloudbase-init are refused", async () => {
    const t = await ctx.templates.register({
      name: "win2019-raw", node: "pve1", proxmoxVmid: 10200, osType: "windows",
      provisioningMethod: "unattend", cloudInitSupport: false, guestAgentRequired: true,
      defaultCpu: 2, defaultRamMb: 4096, defaultDiskGb: 60, supportedProtocols: ["rdp"],
    });
    expect(() => ctx.templates.ensureProvisionable(t)).toThrow(/does not support automated guest provisioning/);
  });

  it("provisioning pipeline fails cleanly when proxmox unconfigured", async () => {
    const vm = await ctx.vms.create({ vmid: 110, node: "pve1", name: "pipe-vm" });
    const job = await ctx.jobs.create({
      vmId: vm.id,
      request: { name: "pipe-vm", templateId: "00000000-0000-0000-0000-0000000000ff" },
      createdByUserId: null,
    });
    const outcome = await runProvisioningJob(ctx, job.id, 0);
    expect(outcome).toBe("FAILED");
    const failed = await ctx.jobs.require(job.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toBeTruthy();
    const steps = await ctx.jobs.getSteps(job.id);
    expect(steps[0]?.state).toBe("FAILED");
  });

  it("jobs: resetForRetry returns failed steps to PENDING", async () => {
    const vm = await ctx.vms.create({ vmid: 111, node: "pve1", name: "retry-vm" });
    const job = await ctx.jobs.create({ vmId: vm.id, request: {}, createdByUserId: null });
    await ctx.jobs.setStep(job.id, "VALIDATE_PROXMOX_RESOURCES", "SUCCEEDED", {}, null);
    await ctx.jobs.setStep(job.id, "CLONE_TEMPLATE", "FAILED", null, "boom");
    await ctx.jobs.resetForRetry(job.id);
    const steps = await ctx.jobs.getSteps(job.id);
    const byStep = new Map(steps.map((s) => [s.step, s.state]));
    expect(byStep.get("VALIDATE_PROXMOX_RESOURCES")).toBe("SUCCEEDED");
    expect(byStep.get("CLONE_TEMPLATE")).toBe("PENDING");
  });
});

describe("provisioning template resolution", () => {
  let ctx: CoreContext;
  let cloneCalls: Array<Record<string, unknown>>;

  function proxmoxMock(resourceTemplateFlag: number): never {
    const base = {
      nodes: async () => [{ node: "pve-node-01", status: "online" }],
      clusterResources: async () => [
        {
          vmid: 126,
          node: "pve-node-01",
          name: "DebianTemplateExample",
          status: "stopped",
          template: resourceTemplateFlag,
          disk: "local-lvm:base-126-disk-0",
        },
      ],
      storages: async () => [{ storage: "local-lvm", content: "images,rootdir" }],
      networks: async () => [{ iface: "vmbr0" }],
      nextId: async () => 201,
      clone: async (args: Record<string, unknown>) => {
        cloneCalls.push(args);
        throw new Error("clone-sentinel");
      },
      waitForTask: async () => undefined,
    };
    return base as never;
  }

  function depsWith(mockProxmox: never): CoreContext {
    return { ...ctx, getProxmoxClient: async () => mockProxmox } as CoreContext;
  }

  beforeAll(async () => {
    ctx = testCtx;
    cloneCalls = [];
    await ctx.templates.register({
      name: "DebianTemplateExample", node: "pve-node-01", proxmoxVmid: 126, osType: "linux",
      provisioningMethod: "cloud-init", cloudInitSupport: true, guestAgentRequired: true,
      defaultCpu: 2, defaultRamMb: 2048, defaultDiskGb: 32, supportedProtocols: ["ssh"],
    });
  });

  it("retry with VALIDATE completed re-resolves the template and reaches CLONE with vmid 126", async () => {
    const job = await ctx.jobs.create({
      vmId: null,
      request: { name: "deb-01", templateId: (await ctx.templates.list()).find((t) => t.proxmoxVmid === 126)!.id, node: "pve-node-01", storage: "local-lvm", osType: "linux", network: { mode: "dhcp" } },
      createdByUserId: null,
    });
    await ctx.jobs.setStep(job.id, "VALIDATE_PROXMOX_RESOURCES", "SUCCEEDED", {}, null);
    const outcome = await runProvisioningJob(depsWith(proxmoxMock(1)), job.id, 2);
    expect(outcome).toBe("FAILED");
    const steps = await ctx.jobs.getSteps(job.id);
    const clone = steps.find((s) => s.step === "CLONE_TEMPLATE");
    expect(clone?.state).toBe("FAILED");
    expect(clone?.error).toMatch(/clone-sentinel/);
    expect(clone?.error).not.toMatch(/Template not resolved/);
    expect(cloneCalls.length).toBe(1);
    expect(cloneCalls[0]?.templateVmid).toBe(126);
    expect(cloneCalls[0]?.node).toBe("pve-node-01");
  });

  it("fails with a clear error when the configured template is not registered", async () => {
    const job = await ctx.jobs.create({
      vmId: null,
      request: { name: "deb-02", templateId: "00000000-0000-0000-0000-0000000000fe", node: "pve-node-01", storage: "local-lvm", osType: "linux", network: { mode: "dhcp" } },
      createdByUserId: null,
    });
    await ctx.jobs.setStep(job.id, "VALIDATE_PROXMOX_RESOURCES", "SUCCEEDED", {}, null);
    const outcome = await runProvisioningJob(depsWith(proxmoxMock(1)), job.id, 2);
    expect(outcome).toBe("FAILED");
    const failed = await ctx.jobs.require(job.id);
    expect(failed.error).toMatch(/registered in ProxVM/);
  });

  it("fails when the resolved VM exists but is not a template", async () => {
    const template = (await ctx.templates.list()).find((t) => t.proxmoxVmid === 126)!;
    const job = await ctx.jobs.create({
      vmId: null,
      request: { name: "deb-03", templateId: template.id, node: "pve-node-01", storage: "local-lvm", osType: "linux", network: { mode: "dhcp", bridge: "vmbr0" } },
      createdByUserId: null,
    });
    const outcome = await runProvisioningJob(depsWith(proxmoxMock(0)), job.id, 1);
    expect(outcome).toBe("FAILED");
    const failed = await ctx.jobs.require(job.id);
    expect(failed.error).toMatch(/exists on node pve-node-01 but is not a template/);
  });

  it("linked clones omit storage/target (Proxmox rejects 'storage' for linked clones); full clones include them", async () => {
    const template = (await ctx.templates.list()).find((t) => t.proxmoxVmid === 126)!;
    const base = { name: "deb-05", templateId: template.id, node: "pve-node-01", storage: "local-lvm", osType: "linux", network: { mode: "dhcp", bridge: "vmbr0" } };

    const linkedJob = await ctx.jobs.create({ vmId: null, request: { ...base, linkedClone: true }, createdByUserId: null });
    await runProvisioningJob(depsWith(proxmoxMock(1)), linkedJob.id, 1);
    const linked = cloneCalls[cloneCalls.length - 1] as Record<string, unknown>;
    expect(linked.full).toBe(false);
    expect("storage" in linked).toBe(false);
    expect("target" in linked).toBe(false);

    const fullJob = await ctx.jobs.create({ vmId: null, request: { ...base, linkedClone: false }, createdByUserId: null });
    await runProvisioningJob(depsWith(proxmoxMock(1)), fullJob.id, 1);
    const full = cloneCalls[cloneCalls.length - 1] as Record<string, unknown>;
    expect(full.full).toBe(true);
    expect(full.storage).toBe("local-lvm");
    expect(full.target).toBe("pve-node-01");
  });

  it("valid template (template: 1, base-126-disk-0) passes validation and reaches clone", async () => {
    const template = (await ctx.templates.list()).find((t) => t.proxmoxVmid === 126)!;
    const job = await ctx.jobs.create({
      vmId: null,
      request: { name: "deb-04", templateId: template.id, node: "pve-node-01", storage: "local-lvm", osType: "linux", network: { mode: "dhcp", bridge: "vmbr0" } },
      createdByUserId: null,
    });
    const outcome = await runProvisioningJob(depsWith(proxmoxMock(1)), job.id, 1);
    expect(outcome).toBe("FAILED");
    const failed = await ctx.jobs.require(job.id);
    expect(failed.error).toMatch(/clone-sentinel/);
    expect(cloneCalls[cloneCalls.length - 1]?.templateVmid).toBe(126);
    expect(cloneCalls[cloneCalls.length - 1]?.newVmid).toBe(201);
  });
});

function silentLogger() {
  const noop = () => undefined;
  return {
    trace: noop, debug: noop, info: noop, warn: noop, error: noop,
    child: () => silentLogger(),
  } as never;
}

function view2_status(_v1: unknown, v2: { status: string } | null): boolean {
  return v2?.status === "VERIFIED";
}

function t2_sameId(_t1: unknown, t2: unknown | null): unknown | null {
  return t2;
}
