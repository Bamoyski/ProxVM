import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import { probeSsh, runSshCommand } from "./ssh/client.js";
import {
  createCore,
  hashPassword,
  rotateVmCredential,
  type CoreContext,
  type LocalConfig,
  type RotationDeps,
} from "./index.js";

vi.mock("./ssh/client.js", () => ({
  probeSsh: vi.fn(),
  runSshCommand: vi.fn(),
}));

const mockedProbeSsh = vi.mocked(probeSsh);
const mockedRunSshCommand = vi.mocked(runSshCommand);

const masterKey = "8".repeat(64);

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

const okSsh = { status: "AUTHENTICATED", detail: "", output: "password updated successfully" } as never;
const refusedSsh = { status: "CONNECTION_FAILED", detail: "connect ECONNREFUSED", output: "" } as never;

describe("credential rotation atomicity", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;
  let actorId: string;
  let n = 0;

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
    const actor = await ctx.users.create({
      username: "rot-actor",
      passwordHash: await hashPassword("Actor-Password-1!"),
      roles: ["ADMIN"],
    });
    actorId = actor.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function setupVm(guac: RotationDeps["guac"]) {
    n += 1;
    const vm = await ctx.vms.create({
      vmid: 710 + n,
      node: "n1",
      name: `atomic-vm-${n}`,
      status: "running",
      osType: "linux",
      ipAddress: "192.0.2.10",
    });
    await ctx.creds.store(vm.id, "deploy", "Old-Password-1!", "PROVISIONED");
    return {
      vmId: vm.id,
      deps: {
        db: ctx.db,
        logger: silentLogger,
        settings: ctx.settings,
        vms: ctx.vms,
        creds: ctx.creds,
        guac,
        audit: ctx.audit,
        decrypt: ctx.decrypt,
        getProxmoxClient: async () => ({}) as never,
        getGuacDb: () => ctx.getGuacDb(),
      } satisfies RotationDeps,
      actor: { userId: actorId!, username: "rot-actor" },
    };
  }

  const realGuac = () => ctx.guac;

  it("confirmed rollback restores the old password as VERIFIED", async () => {
    const { vmId, deps, actor } = await setupVm(realGuac());
    mockedRunSshCommand.mockResolvedValueOnce(okSsh); // apply new
    mockedProbeSsh.mockResolvedValueOnce(refusedSsh); // verify new -> fail
    mockedRunSshCommand.mockResolvedValueOnce(okSsh); // rollback to old
    mockedProbeSsh.mockResolvedValueOnce(okSsh); // re-verify old -> ok

    await expect(rotateVmCredential(deps, vmId, {}, actor)).rejects.toThrow(/previous credential was restored/);

    const row = await ctx.creds.findByVm(vmId);
    expect(ctx.decrypt(row!.password_ciphertext)).toBe("Old-Password-1!");
    expect(row!.status).toBe("VERIFIED");
    const audit = await ctx.audit.list({ vmId, limit: 5 });
    expect((audit[0]!.detail as Record<string, unknown>).result).toBe("rolled-back");
  });

  it("unconfirmed rollback never claims VERIFIED", async () => {
    const { vmId, deps, actor } = await setupVm(realGuac());
    mockedRunSshCommand.mockResolvedValueOnce(okSsh); // apply new
    mockedProbeSsh.mockResolvedValueOnce(refusedSsh); // verify new -> fail
    mockedRunSshCommand.mockRejectedValueOnce(new Error("agent down")); // rollback fails

    await expect(rotateVmCredential(deps, vmId, {}, actor)).rejects.toThrow(/could not be confirmed/);

    const row = await ctx.creds.findByVm(vmId);
    expect(ctx.decrypt(row!.password_ciphertext)).toBe("Old-Password-1!");
    expect(row!.status).not.toBe("VERIFIED");
    expect(row!.status).toBe("FAILED");
    const audit = await ctx.audit.list({ vmId, limit: 5 });
    expect((audit[0]!.detail as Record<string, unknown>).result).toBe("rollback-failed");
  });

  it("Guacamole sync failure is propagated, not swallowed", async () => {
    const failingGuac = { updateConnectionPassword: async () => {
      throw new Error("guac db down");
    } } as never;
    const { vmId, deps, actor } = await setupVm(failingGuac);
    mockedRunSshCommand.mockResolvedValueOnce(okSsh); // apply new
    mockedProbeSsh.mockResolvedValueOnce(okSsh); // verify new -> ok

    const result = await rotateVmCredential(deps, vmId, {}, actor);
    expect(result.success).toBe(true);
    expect(result.guacSynced).toBe(false);
    expect(result.details).toMatch(/NOT updated/);
    const audit = await ctx.audit.list({ vmId, limit: 5 });
    expect((audit[0]!.detail as Record<string, unknown>).result).toBe("success-guac-pending");
    expect((audit[0]!.detail as Record<string, unknown>).guacSynced).toBe(false);
  });
});
