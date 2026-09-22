import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import net from "node:net";
import RedisMock from "ioredis-mock";
import {
  createCore,
  hashPassword,
  parseScheduleDays,
  scheduleDueNow,
  createShareLink,
  redeemShareLink,
  revokeShareLink,
  listShareLinks,
  scanVmServices,
  storeVmServices,
  listVmServices,
  type CoreContext,
  type LocalConfig,
} from "./index.js";

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
    masterKey: "a".repeat(64),
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

describe("schedules", () => {
  it("parses day specs and rejects garbage", () => {
    expect(parseScheduleDays("*")).toBeNull();
    expect(parseScheduleDays("1,5")).toEqual([1, 5]);
    expect(parseScheduleDays("6,0,6")).toEqual([0, 6]);
    expect(() => parseScheduleDays("")).toThrow(/days must be/);
    expect(() => parseScheduleDays("7")).toThrow(/days must be/);
    expect(() => parseScheduleDays("mon")).toThrow(/days must be/);
  });

  it("matches due minutes, days, enabled, and once-per-minute", () => {
    const base = { minute: 30, hour: 2, days: "*", enabled: true, lastRunAt: null };
    expect(scheduleDueNow(base, new Date(2026, 0, 5, 2, 30))).toBe(true); // Monday
    expect(scheduleDueNow(base, new Date(2026, 0, 5, 2, 31))).toBe(false);
    expect(scheduleDueNow({ ...base, enabled: false }, new Date(2026, 0, 5, 2, 30))).toBe(false);
    expect(scheduleDueNow({ ...base, days: "0" }, new Date(2026, 0, 5, 2, 30))).toBe(false); // Sunday-only on Monday
    expect(scheduleDueNow({ ...base, days: "1" }, new Date(2026, 0, 5, 2, 30))).toBe(true);
    expect(scheduleDueNow({ ...base, lastRunAt: new Date(2026, 0, 5, 2, 30) }, new Date(2026, 0, 5, 2, 30))).toBe(false);
    expect(scheduleDueNow({ ...base, lastRunAt: new Date(2026, 0, 4, 2, 30) }, new Date(2026, 0, 5, 2, 30))).toBe(true);
  });
});

describe("share links", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;
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
    const vm = await ctx.vms.create({ vmid: 901, node: "node1", name: "share-vm", status: "stopped", osType: "linux" });
    vmId = vm.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates, redeems, counts uses, and enforces expiry/revocation/max-uses", async () => {
    const { link, token } = await createShareLink(ctx.db, { vmId, protocol: "rdp", expiresInMinutes: 60, maxUses: 2 });
    expect(token.length).toBeGreaterThanOrEqual(64);
    expect(link.useCount).toBe(0);

    // Token hash at rest must not contain the token.
    const stored = await ctx.db.query<{ token_hash: string }>("SELECT token_hash FROM shared_links WHERE id = $1", [link.id]);
    expect(stored.rows[0]!.token_hash).not.toContain(token);

    const first = await redeemShareLink(ctx.db, token);
    expect(first?.vmId).toBe(vmId);
    expect(first?.protocol).toBe("rdp");
    const second = await redeemShareLink(ctx.db, token);
    expect(second?.vmId).toBe(vmId);
    // maxUses: 2 exhausted.
    expect(await redeemShareLink(ctx.db, token)).toBeNull();
    expect(await redeemShareLink(ctx.db, "bogus")).toBeNull();

    const { token: token2 } = await createShareLink(ctx.db, { vmId, protocol: "ssh", expiresInMinutes: 60 });
    expect(await revokeShareLink(ctx.db, (await listShareLinks(ctx.db)).find((l) => l.protocol === "ssh")!.id)).toBe(true);
    expect(await redeemShareLink(ctx.db, token2)).toBeNull();
  });

  it("rejects invalid lifetimes", async () => {
    await expect(createShareLink(ctx.db, { vmId, protocol: "rdp", expiresInMinutes: 1 })).rejects.toThrow(/expiresInMinutes/);
    await expect(createShareLink(ctx.db, { vmId, protocol: "rdp", expiresInMinutes: 60, maxUses: 0 })).rejects.toThrow(/maxUses/);
  });
});

describe("service discovery", () => {
  it("detects open ports and labels known services", async () => {
    const peers = new Set<net.Socket>();
    const server = net.createServer((sock) => {
      peers.add(sock);
      sock.on("close", () => peers.delete(sock));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const found = await scanVmServices("127.0.0.1", { ports: [port, 1], timeoutMs: 2000, concurrency: 2 });
      expect(found.map((f) => f.port)).toContain(port);
      expect(found.map((f) => f.port)).not.toContain(1);
    } finally {
      for (const sock of peers) sock.destroy();
      peers.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("persists and lists snapshots", async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    const ctx2 = await createCore(localConfig, {
      db: pool,
      redis: new RedisMock() as never,
      logger: silentLogger,
    });
    try {
      const vm = await ctx2.vms.create({ vmid: 902, node: "node1", name: "disc-vm", status: "stopped", osType: "linux" });
      await storeVmServices(ctx2.db, vm.id, [{ port: 22, service: "SSH", checkedAt: new Date() }]);
      const listed = await listVmServices(ctx2.db, vm.id);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.service).toBe("SSH");
      await storeVmServices(ctx2.db, vm.id, []);
      expect(await listVmServices(ctx2.db, vm.id)).toHaveLength(0);
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
});
