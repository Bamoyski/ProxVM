import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import { createCore, hashPassword, type CoreContext, type LocalConfig } from "./index.js";
import type { GuacamoleDbClient } from "./guacamole/db.js";

const masterKey = "d".repeat(64);

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

function fakeGuacDb(): GuacamoleDbClient & {
  grants: string[];
  revokes: string[];
  failOnGrant: string | null;
} {
  const self = {
    grants: [] as string[],
    revokes: [] as string[],
    failOnGrant: null as string | null,
    async createConnection(opts: { name: string; protocol: string; params: Record<string, string> }) {
      return opts.name.length;
    },
    async updateConnectionParams() {},
    async grantConnectionRead(connectionName: string, guacUsername: string) {
      if (self.failOnGrant === connectionName) throw new Error(`simulated grant failure on ${connectionName}`);
      self.grants.push(`${connectionName}->${guacUsername}`);
    },
    async revokeConnectionAccess(connectionName: string, guacUsername: string) {
      self.revokes.push(`${connectionName}->${guacUsername}`);
    },
    async deleteConnection() {},
    async getConnection() {
      return null;
    },
    async createUser() {},
    async setUserPassword() {},
    async grantRootGroupRead() {},
    async deleteUser() {},
  };
  return self as never;
}

describe("vm access <-> guacamole synchronization", () => {
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

  it("granting a VM with SSH+RDP grants BOTH connections (no first-connection-only behavior)", async () => {
    const vm = await ctx.vms.create({ vmid: 601, node: "n1", name: "dual-vm" });
    const guacDb = fakeGuacDb();
    await ctx.guac.upsertConnection({
      vmId: vm.id, vmName: vm.name, protocol: "ssh", hostname: "10.0.0.5", port: 22,
      username: "deploy", password: "Secret-Pass-1!", guacDb,
    });
    await ctx.guac.upsertConnection({
      vmId: vm.id, vmName: vm.name, protocol: "rdp", hostname: "10.0.0.5", port: 3389,
      username: "deploy", password: "Secret-Pass-1!", guacDb,
    });
    const user = await ctx.users.create({
      username: "bob", passwordHash: await hashPassword("Bob-Password-1!"), roles: ["USER"],
    });
    await ctx.guac.ensureGuacUser(user.id, user.username, guacDb);
    const guacUsername = (await ctx.guac.findUserRecord(user.id))!.guac_username;

    await ctx.guac.grantVmAccess(vm.id, user.id, guacDb);
    expect(guacDb.grants).toHaveLength(2);
    expect(guacDb.grants).toContain(`proxvm-dual-vm->${guacUsername}`);

    await ctx.guac.revokeVmAccess(vm.id, user.id, guacDb);
    expect(guacDb.revokes).toHaveLength(2);
  });

  it("grant/revoke with no guac user record is a safe no-op", async () => {
    const vm = await ctx.vms.create({ vmid: 602, node: "n1", name: "noop-vm" });
    const guacDb = fakeGuacDb();
    const user = await ctx.users.create({
      username: "nobody", passwordHash: await hashPassword("Nobody-Pass-1!"), roles: ["USER"],
    });
    await expect(ctx.guac.grantVmAccess(vm.id, user.id, guacDb)).resolves.toBeUndefined();
    await expect(ctx.guac.revokeVmAccess(vm.id, user.id, guacDb)).resolves.toBeUndefined();
    expect(guacDb.grants).toHaveLength(0);
    expect(guacDb.revokes).toHaveLength(0);
  });

  it("a grant failure propagates (so callers never write vm_access on failure)", async () => {
    const vm = await ctx.vms.create({ vmid: 603, node: "n1", name: "fail-vm" });
    const guacDb = fakeGuacDb();
    await ctx.guac.upsertConnection({
      vmId: vm.id, vmName: vm.name, protocol: "ssh", hostname: "10.0.0.6", port: 22,
      username: "deploy", password: "Secret-Pass-1!", guacDb,
    });
    await ctx.guac.upsertConnection({
      vmId: vm.id, vmName: vm.name, protocol: "vnc", hostname: "10.0.0.6", port: 5900,
      username: "deploy", password: "Secret-Pass-1!", guacDb,
    });
    const user = await ctx.users.create({
      username: "carol", passwordHash: await hashPassword("Carol-Pass-1!"), roles: ["USER"],
    });
    await ctx.guac.ensureGuacUser(user.id, user.username, guacDb);
    guacDb.failOnGrant = "proxvm-fail-vm";
    await expect(ctx.guac.grantVmAccess(vm.id, user.id, guacDb)).rejects.toThrow("simulated grant failure");
  });

  it("vm_access rows are idempotent, track the granting actor, and clean up fully", async () => {
    const admin = await ctx.users.create({
      username: "root-admin", passwordHash: await hashPassword("Root-Admin-1!"), roles: ["ADMIN"],
    });
    const user = await ctx.users.create({
      username: "dave", passwordHash: await hashPassword("Dave-Password-1!"), roles: ["USER"],
    });
    const vm = await ctx.vms.create({ vmid: 604, node: "n1", name: "row-vm" });

    expect(await ctx.vms.hasAccess(vm.id, user.id)).toBe(false);
    await ctx.vms.setAccess(vm.id, user.id, admin.id);
    await ctx.vms.setAccess(vm.id, user.id, admin.id);
    expect(await ctx.vms.hasAccess(vm.id, user.id)).toBe(true);
    const count = await ctx.db.query("SELECT COUNT(*)::text AS c FROM vm_access WHERE vm_id = $1", [vm.id]);
    expect(Number(count.rows[0]?.c ?? "0")).toBe(1);

    const entries = await ctx.vms.listAccessEntries(vm.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.userId).toBe(user.id);
    expect(entries[0]?.createdBy).toBe(admin.id);
    expect(entries[0]?.createdAt).toBeTruthy();

    // idempotent revoke
    await ctx.vms.revokeAccess(vm.id, user.id);
    await ctx.vms.revokeAccess(vm.id, user.id);
    expect(await ctx.vms.hasAccess(vm.id, user.id)).toBe(false);

    // bulk cleanup (used by VM deletion since soft-delete skips FK cascades)
    await ctx.vms.setAccess(vm.id, user.id, admin.id);
    await ctx.vms.setAccess(vm.id, admin.id, admin.id);
    expect(await ctx.vms.revokeAllAccess(vm.id)).toBe(2);
    expect(await ctx.vms.listAccessEntries(vm.id)).toHaveLength(0);
  });

  it("listVmidsByNode includes soft-deleted rows (vmid-reuse guard)", async () => {
    const vm = await ctx.vms.create({ vmid: 606, node: "n1", name: "gone-vm" });
    expect(await ctx.vms.listVmidsByNode("n1")).toContain(606);
    // findByIdKey ignores soft-deleted rows, but the UNIQUE(vmid, node)
    // constraint still holds them: callers must consult listVmidsByNode.
    await ctx.vms.softDelete(vm.id);
    expect(await ctx.vms.findByIdKey(606, "n1")).toBeNull();
    expect(await ctx.vms.listVmidsByNode("n1")).toContain(606);
  });

  it("deleting a user cascades their vm_access rows (no dangling assignments)", async () => {
    const admin = await ctx.users.create({
      username: "root-admin-2", passwordHash: await hashPassword("Root-Admin-2!"), roles: ["ADMIN"],
    });
    const user = await ctx.users.create({
      username: "erin", passwordHash: await hashPassword("Erin-Password-1!"), roles: ["USER"],
    });
    const vm = await ctx.vms.create({ vmid: 605, node: "n1", name: "cascade-vm" });
    await ctx.vms.setAccess(vm.id, user.id, admin.id);
    expect(await ctx.vms.hasAccess(vm.id, user.id)).toBe(true);
    await ctx.users.deleteGuarded(user.id);
    expect(await ctx.vms.hasAccess(vm.id, user.id)).toBe(false);
    expect(await ctx.vms.listAccessEntries(vm.id)).toHaveLength(0);
  });
});
