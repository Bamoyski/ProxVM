import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  hashPassword,
  rotateVmCredential,
  type CoreContext,
  type LocalConfig,
} from "./index.js";

const masterKey = "7".repeat(64);

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

describe("credential rotation apply-failure", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;

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
  });

  afterAll(async () => {
    await cleanup();
  });

  it("failed rotation does not mark the credential VERIFIED", async () => {
    const vm = await ctx.vms.create({
      vmid: 701,
      node: "n1",
      name: "rot-vm",
      status: "running",
      osType: "linux",
      // Loopback with nothing listening: real SSH connection-refused, no mocks.
      ipAddress: "127.0.0.1",
    });
    await ctx.creds.store(vm.id, "deploy", "Old-Password-1!", "PROVISIONED");

    const actor = await ctx.users.create({
      username: "actor",
      passwordHash: await hashPassword("Actor-Password-1!"),
      roles: ["ADMIN"],
    });
    const actorId = actor.id;

    const failingProxmox = {
      async startAgentExecAndWait(): Promise<never> {
        throw new Error("guest agent unreachable");
      },
    } as never;

    await expect(
      rotateVmCredential(
        {
          db: ctx.db,
          logger: silentLogger,
          settings: ctx.settings,
          vms: ctx.vms,
          creds: ctx.creds,
          guac: ctx.guac,
          audit: ctx.audit,
          decrypt: ctx.decrypt,
          getProxmoxClient: async () => failingProxmox,
          getGuacDb: () => ctx.getGuacDb(),
        },
        vm.id,
        {},
        { userId: actorId!, username: "actor" },
      ),
    ).rejects.toThrow(/Failed to apply the new password/);

    // The guest was never changed: the stored credential must be untouched
    // and its status must NOT claim VERIFIED.
    const row = await ctx.creds.findByVm(vm.id);
    expect(row).toBeTruthy();
    expect(ctx.decrypt(row!.password_ciphertext)).toBe("Old-Password-1!");
    expect(row!.status).toBe("PROVISIONED");
    expect(row!.last_rotated_at).toBeNull();

    const audit = await ctx.audit.list({ vmId: vm.id, limit: 10 });
    const failure = audit.find((a) => a.event === "PASSWORD_ROTATED");
    expect(failure).toBeTruthy();
    expect((failure!.detail as Record<string, unknown>).result).toBe("failed");
  });
});
