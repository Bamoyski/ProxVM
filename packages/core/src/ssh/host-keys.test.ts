import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  hashPassword,
  HostKeyService,
  buildScope,
  keyTypeOf,
  normalizeEndpoint,
  normalizeFingerprint,
  sha256Hex,
  type CoreContext,
  type LocalConfig,
} from "../index.js";

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
  secrets: { sessionSigningKey: "s".repeat(64), masterKeyId: "v1", masterKey },
};

const silentLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as never;

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const FP_C = "c".repeat(64);

/** Builds an SSH-wire host-key blob: uint32 length + algorithm name + payload. */
function hostKeyBlob(algorithm: string, payload = "key-material"): Buffer {
  const name = Buffer.from(algorithm, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(name.length, 0);
  return Buffer.concat([len, name, Buffer.from(payload, "utf8")]);
}

describe("host-key fingerprints and scope helpers", () => {
  it("canonicalizes endpoints (default port, case, IPv6)", () => {
    expect(normalizeEndpoint("192.0.2.10")).toBe("192.0.2.10:22");
    expect(normalizeEndpoint("Host.Example", 2222)).toBe("host.example:2222");
    expect(normalizeEndpoint("fe80::1")).toBe("[fe80::1]:22");
  });

  it("binds a scope to both the VM identity and the endpoint", () => {
    expect(buildScope({ vmId: "VM1", host: "192.0.2.10", port: 22 })).toBe("vm:VM1@192.0.2.10:22");
    expect(buildScope({ host: "192.0.2.10", port: 22 })).toBe("host:192.0.2.10:22");
  });

  it("parses the key algorithm and hashes the raw key", () => {
    const blob = hostKeyBlob("ssh-ed25519");
    expect(keyTypeOf(blob)).toBe("ssh-ed25519");
    expect(sha256Hex(blob)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(blob)).toBe(sha256Hex(blob));
    expect(keyTypeOf(Buffer.from([0, 0, 0, 200, 1, 2, 3]))).toBeNull();
    expect(keyTypeOf(Buffer.from([1, 2, 3]))).toBeNull();
  });

  it("accepts hex and OpenSSH-formatted fingerprints, rejects garbage", () => {
    expect(normalizeFingerprint(FP_A.toUpperCase())).toBe(FP_A);
    const raw = Buffer.from(FP_A, "hex");
    expect(normalizeFingerprint(`SHA256:${raw.toString("base64")}`)).toBe(FP_A);
    expect(normalizeFingerprint("not-a-fingerprint")).toBeNull();
    expect(normalizeFingerprint("SHA256:short")).toBeNull();
    expect(normalizeFingerprint("")).toBeNull();
  });
});

describe("host-key TOFU pinning (pg-mem)", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;
  let vmId: string;
  let vm2Id: string;
  let adminId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, { db: pool, redis: new RedisMock() as never, logger: silentLogger });
    cleanup = async () => {
      await pool.end().catch(() => undefined);
    };
    const admin = await ctx.users.create({
      username: "root",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    adminId = admin.id;
    const vm = await ctx.vms.create({ vmid: 810, node: "n1", name: "hostkey-vm", status: "running", osType: "linux", ipAddress: "192.0.2.10" });
    vmId = vm.id;
    const vm2 = await ctx.vms.create({ vmid: 811, node: "n1", name: "hostkey-vm-2", status: "running", osType: "linux", ipAddress: "192.0.2.11" });
    vm2Id = vm2.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  const policyFor = (id: string, host = "192.0.2.10") => ctx.hostKeys.policy({ vmId: id, host, port: 22 });

  it("does not trust a first key until authentication succeeds (no confirm → no pin)", async () => {
    const policy = policyFor(vmId, "192.0.2.20");
    const decision = await policy.decide(FP_A, "ssh-ed25519");
    expect(decision).toMatchObject({ accept: true, alreadyEnrolled: false });
    // The connection never authenticated: nothing may be persisted.
    expect(await ctx.hostKeys.read({ scope: policy.scope })).toBeNull();
  });

  it("enrolls the key on the first successful authentication and audits it", async () => {
    const policy = policyFor(vmId);
    expect(await policy.confirm(FP_A, "ssh-ed25519")).toMatchObject({ accept: true, alreadyEnrolled: false });
    const pin = await ctx.hostKeys.read({ scope: policy.scope });
    expect(pin?.fingerprint).toBe(FP_A);
    expect(pin?.keyType).toBe("ssh-ed25519");

    const audit = await ctx.audit.list({ vmId, event: "SSH_HOST_KEY_ENROLLED" });
    expect(audit).toHaveLength(1);
    expect((audit[0]?.detail as Record<string, unknown>).fingerprint).toBe(FP_A);
  });

  it("accepts the pinned key on later connections without re-enrolling", async () => {
    const policy = policyFor(vmId);
    expect(await policy.decide(FP_A, "ssh-ed25519")).toMatchObject({ accept: true, alreadyEnrolled: true });
    expect(await policy.confirm(FP_A, "ssh-ed25519")).toMatchObject({ accept: true, alreadyEnrolled: true });
    const audit = await ctx.audit.list({ vmId, event: "SSH_HOST_KEY_ENROLLED" });
    expect(audit).toHaveLength(1);
  });

  it("rejects a changed key before auth and after auth, and audits the mismatch", async () => {
    const policy = policyFor(vmId);
    const before = await policy.decide(FP_B, "ssh-ed25519");
    expect(before.accept).toBe(false);
    expect(before.detail).toMatch(/changed/);

    const after = await policy.confirm(FP_B, "ssh-ed25519");
    expect(after.accept).toBe(false);

    // Pin is untouched: no auto-replacement.
    const pin = await ctx.hostKeys.read({ scope: policy.scope });
    expect(pin?.fingerprint).toBe(FP_A);

    const mismatches = await ctx.audit.list({ vmId, event: "SSH_HOST_KEY_MISMATCH" });
    expect(mismatches.length).toBeGreaterThanOrEqual(2);
    expect((mismatches[0]?.detail as Record<string, unknown>).blocked).toBe(true);
  });

  it("resolves concurrent first connects with different keys atomically (one winner)", async () => {
    const p1 = policyFor(vmId, "192.0.2.21");
    const p2 = policyFor(vmId, "192.0.2.21");
    expect((await p1.decide(FP_A, null)).accept).toBe(true);
    expect((await p2.decide(FP_B, null)).accept).toBe(true);
    const [r1, r2] = await Promise.all([p1.confirm(FP_A, null), p2.confirm(FP_B, null)]);
    const winners = [r1, r2].filter((r) => r.accept);
    expect(winners).toHaveLength(1);

    const pin = await ctx.hostKeys.read({ scope: p1.scope });
    expect([FP_A, FP_B]).toContain(pin?.fingerprint);
    const winningFingerprint = pin?.fingerprint;
    // The loser can never proceed under its key.
    const loser = policyFor(vmId, "192.0.2.21");
    expect((await loser.decide(winningFingerprint === FP_A ? FP_B : FP_A, null)).accept).toBe(false);
  });

  it("lets concurrent same-key enrollments both succeed", async () => {
    const p1 = policyFor(vmId, "192.0.2.22");
    const p2 = policyFor(vmId, "192.0.2.22");
    const [r1, r2] = await Promise.all([p1.confirm(FP_C, null), p2.confirm(FP_C, null)]);
    expect(r1.accept).toBe(true);
    expect(r2.accept).toBe(true);
    expect((await ctx.hostKeys.read({ scope: p1.scope }))?.fingerprint).toBe(FP_C);
  });

  it("keeps pins isolated per VM identity and per endpoint", async () => {
    const other = policyFor(vm2Id, "192.0.2.10");
    expect((await other.decide(FP_A, null)).accept).toBe(true);
    expect((await other.decide(FP_B, null)).accept).toBe(true);
    expect(await ctx.hostKeys.read({ scope: other.scope })).toBeNull();

    const otherEndpoint = policyFor(vmId, "192.0.2.99");
    expect((await otherEndpoint.decide(FP_B, null)).accept).toBe(true);
  });

  it("admin rotate re-verifies the pin to a known fingerprint and audits it", async () => {
    const policy = policyFor(vmId);
    const updated = await ctx.hostKeys.setFingerprint({
      vmId,
      host: "192.0.2.10",
      port: 22,
      fingerprint: `SHA256:${Buffer.from(FP_C, "hex").toString("base64")}`,
      actorUserId: adminId,
      actorUsername: "root",
    });
    expect(updated?.fingerprint).toBe(FP_C);
    expect((await ctx.hostKeys.read({ scope: policy.scope }))?.fingerprint).toBe(FP_C);
    expect((await policy.decide(FP_C, null)).accept).toBe(true);
    expect((await policy.decide(FP_A, null)).accept).toBe(false);

    const audit = await ctx.audit.list({ event: "SSH_HOST_KEY_ROTATED" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUsername).toBe("root");
  });

  it("admin rotate refuses malformed fingerprints and unpinned scopes", async () => {
    await expect(
      ctx.hostKeys.setFingerprint({ vmId, host: "192.0.2.10", port: 22, fingerprint: "nope" }),
    ).rejects.toThrow(/not a recognized SSH host-key fingerprint/);
    const missing = await ctx.hostKeys.setFingerprint({
      vmId,
      host: "192.0.2.123",
      port: 22,
      fingerprint: FP_C,
    });
    expect(missing).toBeNull();
  });

  it("admin unpin clears the pin (audited) and the next connection re-enrolls", async () => {
    const policy = policyFor(vmId);
    const removed = await ctx.hostKeys.unpin({ vmId, host: "192.0.2.10", port: 22, actorUserId: adminId, actorUsername: "root" });
    expect(removed).toBe(true);
    expect(await ctx.hostKeys.read({ scope: policy.scope })).toBeNull();
    expect(await ctx.hostKeys.unpin({ vmId, host: "192.0.2.10", port: 22 })).toBe(false);

    const audit = await ctx.audit.list({ event: "SSH_HOST_KEY_UNPINNED" });
    expect(audit).toHaveLength(1);

    const fresh = policyFor(vmId);
    expect(await fresh.confirm(FP_B, "ssh-rsa")).toMatchObject({ accept: true, alreadyEnrolled: false });
    expect((await ctx.hostKeys.read({ scope: fresh.scope }))?.fingerprint).toBe(FP_B);
  });

  it("fails closed on a malformed stored fingerprint and on datastore errors", async () => {
    const scope = `vm:${vmId}@192.0.2.30:22`;
    await ctx.db.query(
      "INSERT INTO ssh_host_keys (id, scope, vm_id, endpoint, fingerprint, key_type) VALUES ($1, $2, $3, $4, $5, $6)",
      ["99999999-9999-4999-8999-999999999999", scope, vmId, "192.0.2.30:22", "not-a-fingerprint", null],
    );
    const policy = ctx.hostKeys.policy({ vmId, host: "192.0.2.30", port: 22 });
    expect((await policy.decide(FP_A, null)).accept).toBe(false);
    expect((await policy.confirm(FP_A, null)).accept).toBe(false);

    const brokenDb = {
      query: async () => {
        throw new Error("datastore unavailable");
      },
    };
    const broken = new HostKeyService({ db: brokenDb as never });
    const brokenPolicy = broken.policy({ vmId, host: "192.0.2.40", port: 22 });
    expect((await brokenPolicy.decide(FP_A, null)).accept).toBe(false);
    expect((await brokenPolicy.confirm(FP_A, null)).accept).toBe(false);
  });

  it("lists pinned endpoints for a VM", async () => {
    const pins = await ctx.hostKeys.listForVm(vmId);
    expect(pins.length).toBeGreaterThan(0);
    expect(pins.map((p) => p.endpoint)).toContain("192.0.2.21:22");
    for (const pin of pins) expect(pin.vmId).toBe(vmId);
  });
});
