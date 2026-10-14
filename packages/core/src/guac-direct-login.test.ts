import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  hashPassword,
  type CoreContext,
  type LocalConfig,
} from "./index.js";

const masterKey = "c".repeat(64);

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

/** Minimal Guac DB double: records password writes per username. */
function stubGuacDb() {
  const passwords = new Map<string, string>();
  const created: string[] = [];
  return {
    passwords,
    created,
    async createUser(input: { username: string; password: string }): Promise<number> {
      if (!passwords.has(input.username)) {
        passwords.set(input.username, input.password);
        created.push(input.username);
      }
      return 1;
    },
    async setUserPassword(username: string, password: string): Promise<void> {
      if (!passwords.has(username)) throw new Error("no such user");
      passwords.set(username, password);
    },
    async grantRootGroupRead(): Promise<void> {},
  };
}

describe("guacamole direct login", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;
  let viennaId: string;

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
    const vienna = await ctx.users.create({
      username: "vienna",
      passwordHash: await hashPassword("Vienna-Password-1!"),
      roles: ["USER"],
    });
    viennaId = vienna.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("rejects an empty password", async () => {
    await expect(
      ctx.guac.setGuacDirectLoginPassword(viennaId, "vienna", "", stubGuacDb() as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("creates the account when missing, then sets the known password", async () => {
    const guacDb = stubGuacDb();
    const record = await ctx.guac.setGuacDirectLoginPassword(viennaId, "vienna", "Vienna-Direct-1!", guacDb as never);
    expect(record.guac_username).toBe("px_vienna");
    expect(guacDb.created).toContain("px_vienna");
    expect(guacDb.passwords.get("px_vienna")).toBe("Vienna-Direct-1!");
    // Local mirror carries the same value (launch flow keeps working) + flag.
    const stored = await ctx.guac.findUserRecord(viennaId);
    expect(stored?.direct_login_enabled).toBe(true);
    expect(stored?.direct_login_set_at).not.toBeNull();
    expect(ctx.decrypt(stored!.password_ciphertext)).toBe("Vienna-Direct-1!");
  });

  it("disabling rotates to a fresh unknown password and clears the flag", async () => {
    const guacDb = stubGuacDb();
    guacDb.passwords.set("px_vienna", "Vienna-Direct-1!");
    const record = await ctx.guac.disableGuacDirectLogin(viennaId, guacDb as never);
    expect(record?.direct_login_enabled).toBe(false);
    const rotated = guacDb.passwords.get("px_vienna")!;
    expect(rotated).not.toBe("Vienna-Direct-1!");
    const stored = await ctx.guac.findUserRecord(viennaId);
    expect(stored?.direct_login_enabled).toBe(false);
    expect(stored?.direct_login_set_at).toBeNull();
    expect(ctx.decrypt(stored!.password_ciphertext)).toBe(rotated);
  });

  it("disabling a user with no Guacamole account is a null no-op", async () => {
    const bob = await ctx.users.create({
      username: "nodirect-bob",
      passwordHash: await hashPassword("Bob-Password-1!"),
      roles: ["USER"],
    });
    await expect(ctx.guac.disableGuacDirectLogin(bob.id, stubGuacDb() as never)).resolves.toBeNull();
  });
});
