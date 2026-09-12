import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  hashPassword,
  resolveProvisionDefaults,
  resolveProvisionRequest,
  type CoreContext,
  type LocalConfig,
} from "./index.js";

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

function fakeProxmox(nodes = ["node1"], bridges = ["vmbr0"], storages = ["local-lvm"]) {
  return {
    async nodes() {
      return nodes.map((node) => ({ node }));
    },
    async storages() {
      return storages.map((storage) => ({ storage, content: "images,rootdir" }));
    },
    async networks() {
      return bridges.map((iface) => ({ iface }));
    },
  } as never;
}

describe("provisioning defaults resolution", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;
  let templateId: string;
  let adminId: string;
  let userId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMock() as never,
      logger: { trace: () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => undefined } as never,
    });
    cleanup = async () => {
      await pool.end().catch(() => undefined);
    };
    await ctx.settings.set("proxmox.url", "https://proxmox.example:8006");
    await ctx.settings.set("proxmox.token_id", "root@pam!test");
    await ctx.settings.set("proxmox.token_secret", "test-secret-value");
    await ctx.settings.set("proxmox.default_node", "node1");
    await ctx.settings.set("proxmox.default_storage", "local-lvm");
    await ctx.settings.set("proxmox.default_network", "vmbr0");
    const template = await ctx.templates.register({
      name: "debian",
      node: "node1",
      proxmoxVmid: 9000,
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
    const admin = await ctx.users.create({
      username: "admin", passwordHash: await hashPassword("Admin-Password-1!"), roles: ["ADMIN"],
    });
    adminId = admin.id;
    const user = await ctx.users.create({
      username: "bob", passwordHash: await hashPassword("Bob-Password-1!"), roles: ["USER"],
    });
    userId = user.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  const deps = () => ({
    settings: ctx.settings,
    templates: ctx.templates,
    users: ctx.users,
    getProxmoxClient: async () => fakeProxmox(),
  });

  it("minimal Basic input resolves configured + template defaults", async () => {
    const admin = (await ctx.users.findById(adminId))!;
    const resolved = await resolveProvisionRequest(deps(), {
      name: "lab-01",
      templateId,
      password: "Basic-Password-1!",
      startAfterProvision: true,
      linkedClone: true,
      assignToUserIds: [],
    });
    expect(resolved.node).toBe("node1");
    expect(resolved.storage).toBe("local-lvm");
    expect(resolved.network.bridge).toBe("vmbr0");
    expect(resolved.network.mode).toBe("dhcp");
    expect(resolved.cpu).toBe(2);
    expect(resolved.ramMb).toBe(4096);
    expect(resolved.diskGb).toBe(32);
    expect(resolved.guestUser).toBe("deploy");
    expect(resolved.osType).toBe("linux");
    // protocols omitted -> template's supportedProtocols survive final validation default
    expect(resolved.protocols).toBeUndefined();
  });

  it("explicit values are preserved (Advanced passthrough)", async () => {
    const admin = (await ctx.users.findById(adminId))!;
    const resolved = await resolveProvisionRequest(deps(), {
      name: "lab-02",
      templateId,
      node: "node1",
      vmid: 210,
      cpu: 4,
      ramMb: 8192,
      diskGb: 64,
      storage: "local-lvm",
      network: { bridge: "vmbr0", vlan: 10, mode: "static", ip: "10.0.0.5", cidr: 24, gateway: "10.0.0.1" },
      osType: "linux",
      protocols: ["rdp"],
      guestUser: "operator",
      password: "Advanced-Pass-1!",
      startAfterProvision: true,
      linkedClone: false,
      assignToUserIds: [userId],
    });
    expect(resolved.cpu).toBe(4);
    expect(resolved.ramMb).toBe(8192);
    expect(resolved.diskGb).toBe(64);
    expect(resolved.network).toMatchObject({ bridge: "vmbr0", vlan: 10, mode: "static", ip: "10.0.0.5" });
    expect(resolved.protocols).toEqual(["rdp"]);
    expect(resolved.guestUser).toBe("operator");
    expect(resolved.linkedClone).toBe(false);
    expect(resolved.assignToUserIds).toEqual([userId]);
  });

  it("protocols outside the template's support are rejected", async () => {
    const admin = (await ctx.users.findById(adminId))!;
    await expect(
      resolveProvisionRequest(deps(), {
        name: "lab-03",
        templateId,
        protocols: ["vnc"],
        password: "Basic-Password-1!",
        startAfterProvision: true,
        linkedClone: true,
        assignToUserIds: [],
      }),
    ).rejects.toThrow(/does not support protocol/);
  });

  it("static networking without ip+gateway is rejected before anything is provisioned", async () => {
    const admin = (await ctx.users.findById(adminId))!;
    await expect(
      resolveProvisionRequest(deps(), {
        name: "lab-static",
        templateId,
        network: { mode: "static", ip: "10.0.0.5" },
        password: "Basic-Password-1!",
        startAfterProvision: true,
        linkedClone: true,
        assignToUserIds: [],
      }),
    ).rejects.toThrow(/Static networking requires both ip and gateway/);
    // No VM row may exist: validation happens before any provisioning step.
    expect(await ctx.vms.findByIdKey(0, "node1")).toBeNull();
  });

  it("unknown assigned users are rejected (vm.edit is enforced by the route)", async () => {
    await expect(
      resolveProvisionRequest(deps(), {
        name: "lab-04",
        templateId,
        password: "Basic-Password-1!",
        startAfterProvision: true,
        linkedClone: true,
        assignToUserIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("defaults endpoint verifies against live Proxmox and falls back clearly", async () => {
    const ok = await resolveProvisionDefaults(deps(), { templateId });
    expect(ok.verified).toBe(true);
    expect(ok.node).toBe("node1");
    expect(ok.storage).toBe("local-lvm");
    expect(ok.bridge).toBe("vmbr0");
    expect(ok.protocols).toEqual(["ssh", "rdp"]);
    expect(ok.warnings).toHaveLength(0);

    const missing = await resolveProvisionDefaults(
      {
        settings: ctx.settings,
        templates: ctx.templates,
        users: ctx.users,
        getProxmoxClient: async () => fakeProxmox(["node1"], ["vmbr9"], ["other-store"]),
      },
      { templateId },
    );
    expect(missing.verified).toBe(true);
    expect(missing.storage).toBe("other-store");
    expect(missing.bridge).toBe("vmbr9");
    expect(missing.warnings.length).toBeGreaterThan(0);

    const down = await resolveProvisionDefaults(
      {
        settings: ctx.settings,
        templates: ctx.templates,
        users: ctx.users,
        getProxmoxClient: async () => {
          throw new Error("connection refused");
        },
      },
      { templateId },
    );
    expect(down.verified).toBe(false);
    expect(down.storage).toBe("local-lvm");
    expect(down.bridge).toBe("vmbr0");
  });
});
