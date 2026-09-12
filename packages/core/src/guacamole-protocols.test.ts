import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import { createCore, resolveProtocols, type CoreContext, type LocalConfig } from "./index.js";
import type { GuacamoleDbClient } from "./guacamole/db.js";
import type { GuacConnectionRow } from "./services/rows.js";

const masterKey = "a".repeat(64);

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

interface CreatedConnection {
  name: string;
  protocol: string;
  params: Record<string, string>;
}

function fakeGuacDb(): GuacamoleDbClient & { created: CreatedConnection[]; grants: string[]; nextId: number } {
  const self = {
    created: [] as CreatedConnection[],
    grants: [] as string[],
    nextId: 10,
    async createConnection(opts: { name: string; protocol: string; params: Record<string, string> }) {
      self.created.push({ ...opts });
      return self.nextId++;
    },
    async updateConnectionParams(_name: string, _params: Record<string, string>) {},
    async grantConnectionRead(connectionName: string, guacUsername: string) {
      self.grants.push(`${connectionName}->${guacUsername}`);
    },
    async revokeConnectionAccess() {},
    async deleteConnection() {},
    async getConnection(name: string) {
      const c = self.created.find((x) => x.name === name);
      return c ? { connection_id: 1, protocol: c.protocol } : null;
    },
    async createUser() {},
    async setUserPassword() {},
    async grantRootGroupRead() {},
    async deleteUser() {},
  };
  return self as never;
}

describe("guacamole access protocol selection", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;

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
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createVm(name: string): Promise<string> {
    const vm = await ctx.vms.create({ vmid: 500 + Math.floor(Math.random() * 10000), node: "pve-node-01", name });
    return vm.id;
  }

  it("RDP-only selection creates an RDP connection with ignore-cert and NO SSH connection", async () => {
    const vmId = await createVm("rdp-only-vm");
    const guacDb = fakeGuacDb();
    const { record } = await ctx.guac.upsertConnection({
      vmId, vmName: "rdp-only-vm", protocol: "rdp", hostname: "192.168.1.50", port: 3389,
      username: "deploy", password: "Secret-Pass-1!", guacDb,
    });
    expect(record.protocol).toBe("rdp");
    const all = await ctx.guac.listConnectionRecords(vmId);
    expect(all).toHaveLength(1);
    expect(all[0]!.protocol).toBe("rdp");
    const created = guacDb.created[0]!;
    expect(created.protocol).toBe("rdp");
    expect(created.params["ignore-cert"]).toBe("true");
    expect(guacDb.created.some((c) => c.protocol === "ssh")).toBe(false);
  });

  it("SSH-only selection creates an SSH connection and NO RDP connection", async () => {
    const vmId = await createVm("ssh-only-vm");
    const guacDb = fakeGuacDb();
    await ctx.guac.upsertConnection({
      vmId, vmName: "ssh-only-vm", protocol: "ssh", hostname: "192.168.1.60", port: 22,
      username: "deploy", password: "Secret-Pass-1!", guacDb,
    });
    const all = await ctx.guac.listConnectionRecords(vmId);
    expect(all).toHaveLength(1);
    expect(all[0]!.protocol).toBe("ssh");
    expect(guacDb.created[0]!.params["ignore-cert"]).toBeUndefined();
    expect(guacDb.created.some((c) => c.protocol === "rdp")).toBe(false);
  });

  it("RDP + SSH creates both connections with distinct names, and access is granted on both", async () => {
    const vmId = await createVm("both-vm");
    const guacDb = fakeGuacDb();
    for (const protocol of ["rdp", "ssh"] as const) {
      await ctx.guac.upsertConnection({
        vmId, vmName: "both-vm", protocol,
        hostname: "192.168.1.70", port: protocol === "rdp" ? 3389 : 22,
        username: "deploy", password: "Secret-Pass-1!", guacDb,
        connectionName: `proxvm-both-vm-${protocol}`,
      });
    }
    const all = await ctx.guac.listConnectionRecords(vmId);
    expect(all.map((r: GuacConnectionRow) => r.protocol).sort()).toEqual(["rdp", "ssh"]);
    const user = await ctx.users.create({
      username: "bothuser",
      passwordHash: "x".repeat(64),
      roles: ["USER"],
    });
    await ctx.guac.ensureGuacUser(user.id, "bothuser", guacDb);
    await ctx.guac.grantVmAccess(vmId, user.id, guacDb);
    expect(guacDb.grants).toContain("proxvm-both-vm-rdp->px_bothuser");
    expect(guacDb.grants).toContain("proxvm-both-vm-ssh->px_bothuser");
  });

  it("protocol lookup by protocol returns the matching record", async () => {
    const vmId = await createVm("lookup-vm");
    const guacDb = fakeGuacDb();
    for (const protocol of ["rdp", "ssh"] as const) {
      await ctx.guac.upsertConnection({
        vmId, vmName: "lookup-vm", protocol, hostname: "192.168.1.80",
        port: protocol === "rdp" ? 3389 : 22, username: "deploy", password: "Secret-Pass-1!", guacDb,
      });
    }
    const rdp = await ctx.guac.findConnectionRecord(vmId, "rdp");
    const ssh = await ctx.guac.findConnectionRecord(vmId, "ssh");
    expect(rdp?.protocol).toBe("rdp");
    expect(rdp?.port).toBe(3389);
    expect(ssh?.protocol).toBe("ssh");
    expect(ssh?.port).toBe(22);
  });

  it("resolveProtocols: request selection is authoritative, template fallback, OS default last", () => {
    expect(resolveProtocols({ protocols: ["rdp"], osType: "linux" }, { supportedProtocols: ["ssh"] })).toEqual(["rdp"]);
    expect(resolveProtocols({ protocols: undefined, osType: "linux" }, { supportedProtocols: ["rdp"] })).toEqual(["rdp"]);
    expect(resolveProtocols({ protocols: undefined, osType: "linux" }, { supportedProtocols: ["ssh", "rdp"] })).toEqual(["ssh", "rdp"]);
    expect(resolveProtocols({ protocols: undefined, osType: "linux" }, { supportedProtocols: [] })).toEqual(["ssh"]);
    expect(resolveProtocols({ protocols: undefined, osType: "windows" }, { supportedProtocols: [] })).toEqual(["rdp"]);
    expect(resolveProtocols({ protocols: ["ssh", "ssh", "rdp"], osType: "linux" }, null)).toEqual(["ssh", "rdp"]);
  });
});
