import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  hashPassword,
  resolveEffectiveAccess,
  checkAccess,
  allowedProtocols,
  type CoreContext,
  type LocalConfig,
} from "./index.js";

const masterKey = "3".repeat(64);

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

const silentLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as never;

describe("IAM engine", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;
  let aliceId: string;
  let vmId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMock() as never,
      logger: silentLogger,
    });
    cleanup = async () => {
      await pool.end().catch(() => undefined);
    };
    const alice = await ctx.users.create({
      username: "alice",
      passwordHash: await hashPassword("Alice-Password-1!"),
      roles: ["USER"],
    });
    aliceId = alice.id;
    const vm = await ctx.vms.create({ vmid: 801, node: "n1", name: "iam-vm" });
    vmId = vm.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("migration 007 seeds catalog, presets and extends tables", async () => {
    const perms = await ctx.db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM permissions");
    expect(Number(perms.rows[0]?.count ?? "0")).toBeGreaterThanOrEqual(28);
    const roles = await ctx.db.query<{ name: string }>(
      "SELECT name FROM roles WHERE is_system ORDER BY name",
    );
    const names = roles.rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(["ADMIN", "OPERATOR", "USER", "Viewer", "VM Manager", "VM Operator", "Provisioner"]),
    );
    const cols = await ctx.db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'vm_access'",
    );
    const colNames = cols.rows.map((c) => c.column_name);
    expect(colNames).toContain("protocols");
    expect(colNames).toContain("expires_at");
  });

  it("legacy USER resolves to the legacy permission set", async () => {
    const eff = await resolveEffectiveAccess(ctx.db, aliceId);
    expect(eff.permissions.has("vm.read")).toBe(true);
    expect(eff.permissions.has("guac.launch")).toBe(true);
    expect(eff.permissions.has("vm.delete")).toBe(false);
    expect(eff.vmAccess.size).toBe(0);
  });

  it("direct grants, expiries and protocol scoping compose", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();
    await ctx.db.query(
      "INSERT INTO user_permissions (user_id, permission, expires_at) VALUES ($1, 'vm.delete', $2)",
      [aliceId, future],
    );
    await ctx.db.query(
      "INSERT INTO user_permissions (user_id, permission, expires_at) VALUES ($1, 'users.manage', $2)",
      [aliceId, past],
    );
    await ctx.db.query(
      "INSERT INTO vm_access (vm_id, user_id, protocols, expires_at) VALUES ($1, $2, $3, $4)",
      [vmId, aliceId, ["rdp"], future],
    );
    const eff = await resolveEffectiveAccess(ctx.db, aliceId);
    // Live grant applies; expired grant does not.
    expect(eff.permissions.has("vm.delete")).toBe(true);
    expect(eff.permissions.has("users.manage")).toBe(false);
    expect(allowedProtocols(eff, vmId)).toEqual(["rdp"]);

    const alice = (await ctx.users.findById(aliceId))!;
    expect((await checkAccess(ctx.db, alice, { permission: "vm.delete" })).allowed).toBe(true);
    expect((await checkAccess(ctx.db, alice, { permission: "users.manage" })).reason).toBe("missing_permission");
    expect((await checkAccess(ctx.db, alice, { vmId, protocol: "rdp" })).allowed).toBe(true);
    expect((await checkAccess(ctx.db, alice, { vmId, protocol: "ssh" })).reason).toBe("protocol_denied");
  });

  it("expired VM access denies with access_expired", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await ctx.db.query("UPDATE vm_access SET protocols = NULL, expires_at = $1 WHERE vm_id = $2 AND user_id = $3", [
      past,
      vmId,
      aliceId,
    ]);
    const alice = (await ctx.users.findById(aliceId))!;
    const check = await checkAccess(ctx.db, alice, { vmId });
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("access_expired");
  });

  it("group membership confers roles and VM access", async () => {
    // Fresh VM so earlier direct rows do not interfere.
    const vm2 = await ctx.vms.create({ vmid: 802, node: "n1", name: "iam-vm-2" });
    const gid = "aaaaaaaa-1111-4111-8111-111111111111";
    await ctx.db.query("INSERT INTO groups (id, name) VALUES ($1, 'students')", [gid]);
    await ctx.db.query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [gid, aliceId]);
    await ctx.db.query(
      "INSERT INTO group_roles (group_id, role_id) VALUES ($1, '00000000-0000-0000-0000-000000000102')",
      [gid],
    );
    await ctx.db.query("INSERT INTO group_vm_access (group_id, vm_id, protocols) VALUES ($1, $2, $3)", [
      gid,
      vm2.id,
      ["ssh"],
    ]);
    const eff = await resolveEffectiveAccess(ctx.db, aliceId);
    expect(eff.permissions.has("vm.start")).toBe(true);
    expect(eff.permissions.get("vm.start")).toEqual(
      expect.arrayContaining(["group role:VM Operator via students"]),
    );
    expect(allowedProtocols(eff, vm2.id)).toEqual(["ssh"]);
    const alice = (await ctx.users.findById(aliceId))!;
    expect((await checkAccess(ctx.db, alice, { vmId: vm2.id, protocol: "ssh" })).allowed).toBe(true);
    expect((await checkAccess(ctx.db, alice, { vmId: vm2.id, protocol: "rdp" })).reason).toBe("protocol_denied");
  });

  it("sweep revokes Guac access, prunes expired rows and audits", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const vm = await ctx.vms.create({ vmid: 804, node: "n1", name: "iam-vm-4" });
    const bob = await ctx.users.create({
      username: "sweep-bob",
      passwordHash: await hashPassword("Bob-Password-1!"),
      roles: ["USER"],
    });
    await ctx.db.query("INSERT INTO vm_access (vm_id, user_id, expires_at) VALUES ($1, $2, $3)", [vm.id, aliceId, past]);
    await ctx.db.query("INSERT INTO vm_access (vm_id, user_id, expires_at) VALUES ($1, $2, $3)", [vm.id, bob.id, future]);
    const revoked: string[] = [];
    const fakeGuacDb = {
      revokeConnectionAccess: async (connectionName: string, guacUsername: string) => {
        revoked.push(`${connectionName}->${guacUsername}`);
      },
    } as never;
    const result = await (
      await import("./services/iam.js")
    ).sweepExpiredVmAccess(
      {
        db: ctx.db,
        vms: ctx.vms,
        guac: ctx.guac,
        getGuacDb: async () => fakeGuacDb,
        audit: ctx.audit,
        logger: silentLogger,
      },
    );
    expect(result.revoked).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);
    // Expired direct row pruned; live row untouched.
    const gone = await ctx.db.query("SELECT * FROM vm_access WHERE vm_id = $1 AND user_id = $2", [vm.id, aliceId]);
    expect(gone.rows).toHaveLength(0);
    const kept = await ctx.db.query<{ expires_at: Date | null }>(
      "SELECT expires_at FROM vm_access WHERE vm_id = $1 AND user_id = $2",
      [vm.id, bob.id],
    );
    expect(kept.rows).toHaveLength(1);
    const audit = await ctx.audit.list({ vmId: vm.id, limit: 20 });
    expect(audit.map((a) => a.event)).toContain("TEMPORARY_ACCESS_EXPIRED");
  });

  it("global protocol grants scope legacy (unscoped) VM access", async () => {
    const bob = await ctx.users.create({
      username: "bob",
      passwordHash: await hashPassword("Bob-Password-1!"),
      roles: ["USER"],
    });
    const vm3 = await ctx.vms.create({ vmid: 803, node: "n1", name: "iam-vm-3" });
    // Legacy-style access row: protocols NULL.
    await ctx.db.query("INSERT INTO vm_access (vm_id, user_id) VALUES ($1, $2)", [vm3.id, bob.id]);
    // No global protocol grants yet -> all protocols allowed (legacy behavior).
    let eff = await resolveEffectiveAccess(ctx.db, bob.id);
    expect(allowedProtocols(eff, vm3.id)).toBeNull();
    // A global RDP-only grant (e.g. via an "RDP Operator" role) scopes it.
    await ctx.db.query("INSERT INTO user_permissions (user_id, permission) VALUES ($1, 'protocol.rdp')", [bob.id]);
    eff = await resolveEffectiveAccess(ctx.db, bob.id);
    expect(allowedProtocols(eff, vm3.id)).toEqual(["rdp"]);
    const bobFull = (await ctx.users.findById(bob.id))!;
    expect((await checkAccess(ctx.db, bobFull, { vmId: vm3.id, protocol: "rdp" })).allowed).toBe(true);
    expect((await checkAccess(ctx.db, bobFull, { vmId: vm3.id, protocol: "ssh" })).reason).toBe("protocol_denied");
  });
});
