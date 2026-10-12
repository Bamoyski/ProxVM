import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import { probeSsh, runSshCommand } from "./ssh/client.js";
import {
  createCore,
  hashPassword,
  rotateVmCredential,
  windowsUsernameError,
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

const silentLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as never;

const okSsh = { status: "AUTHENTICATED", detail: "", output: "password updated successfully" } as never;

describe("rotation concurrency claims", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;
  let actorId: string;

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
      username: "claim-actor",
      passwordHash: await hashPassword("Actor-Password-1!"),
      roles: ["ADMIN"],
    });
    actorId = actor.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function setupVm(): Promise<{ vmId: string; deps: RotationDeps }> {
    const vm = await ctx.vms.create({
      vmid: 720 + Math.floor(Math.random() * 1000),
      node: "n1",
      name: `claim-vm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      status: "running",
      osType: "linux",
      ipAddress: "192.0.2.20",
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
        guac: ctx.guac,
        audit: ctx.audit,
        decrypt: ctx.decrypt,
        hostKeys: ctx.hostKeys,
        getProxmoxClient: async () => ({}) as never,
        getGuacDb: () => ctx.getGuacDb(),
      } satisfies RotationDeps,
    };
  }

  it("second concurrent claim loses (compare-and-set)", async () => {
    const { vmId } = await setupVm();
    expect(await ctx.creds.tryClaimRotation(vmId)).toBe(true);
    expect(await ctx.creds.tryClaimRotation(vmId)).toBe(false);
    await ctx.creds.setStatus(vmId, "PROVISIONED");
    expect(await ctx.creds.tryClaimRotation(vmId)).toBe(true);
  });

  it("rotation while ROTATING is rejected with 409", async () => {
    const { vmId, deps } = await setupVm();
    await ctx.creds.setStatus(vmId, "ROTATING");
    await expect(
      rotateVmCredential(deps, vmId, {}, { userId: actorId, username: "claim-actor" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("forced retry recovers a stuck ROTATING claim", async () => {
    const { vmId, deps } = await setupVm();
    await ctx.creds.setStatus(vmId, "ROTATING");
    mockedRunSshCommand.mockResolvedValueOnce(okSsh);
    mockedProbeSsh.mockResolvedValueOnce(okSsh);
    const failingGuac = {
      updateConnectionPassword: async () => undefined,
    } as never;
    const result = await rotateVmCredential(
      { ...deps, guac: failingGuac },
      vmId,
      { verify: false, force: true },
      { userId: actorId, username: "claim-actor" },
    );
    expect(result.success).toBe(true);
    const audit = await ctx.audit.list({ vmId, limit: 5 });
    expect(audit.map((a) => (a.detail as Record<string, unknown> | null)?.result)).toContain(
      "forced-retry-after-stuck-claim",
    );
  });

  it("windows usernames are gated like passwords", () => {
    expect(windowsUsernameError("deploy")).toBeNull();
    expect(windowsUsernameError('a"b')).not.toBeNull();
    expect(windowsUsernameError("a\nb")).not.toBeNull();
    expect(windowsUsernameError("%PATH%")).not.toBeNull();
    expect(windowsUsernameError("a&b")).not.toBeNull();
  });
});
