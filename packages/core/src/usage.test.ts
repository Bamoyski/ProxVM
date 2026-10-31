import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  openPowerPeriod,
  closePowerPeriod,
  reconcileVmPower,
  monthlyUsage,
  getUserQuota,
  setUserQuota,
  countUserVms,
  createTicket,
  listTickets,
  setTicketStatus,
  ticketQueueStats,
  dailyUsage,
  getAnnouncement,
  setAnnouncement,
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
    masterKey: "d".repeat(64),
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

describe("usage metering", () => {
  let ctx: CoreContext;
  let pool: Pool;
  let vmId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMock() as never,
      logger: silentLogger,
    });
    const vm = await ctx.vms.create({ vmid: 999, node: "testnode", name: "meter-me" });
    vmId = vm.id;
  });

  afterAll(async () => {
    await pool.end().catch(() => undefined);
  });

  it("opens/closes idempotently and reconciles transitions only", async () => {
    expect(await reconcileVmPower(pool, vmId, false)).toBe("unchanged");
    expect(await reconcileVmPower(pool, vmId, true)).toBe("opened");
    expect(await reconcileVmPower(pool, vmId, true)).toBe("unchanged");
    // Double-open collapses to one open period.
    await openPowerPeriod(pool, vmId);
    const open = await pool.query("SELECT COUNT(*) AS c FROM vm_power_periods WHERE vm_id = $1 AND ended_at IS NULL", [vmId]);
    expect(Number(open.rows[0].c)).toBe(1);
    expect(await reconcileVmPower(pool, vmId, false)).toBe("closed");
    expect(await closePowerPeriod(pool, vmId)).toBe(0);
  });

  it("sums monthly hours across open and closed periods", async () => {
    await pool.query("DELETE FROM vm_power_periods WHERE vm_id = $1", [vmId]);
    // Closed 90-minute period last month (relative to a fixed anchor).
    await pool.query(
      "INSERT INTO vm_power_periods (id, vm_id, started_at, ended_at) VALUES ('11111111-1111-4111-8111-111111111111', $1, '2026-01-10T10:00:00Z', '2026-01-10T11:30:00Z')",
      [vmId],
    );
    const rows = await monthlyUsage(pool, "2026-01");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hours).toBeCloseTo(1.5, 5);
    expect(await monthlyUsage(pool, "2026-02")).toHaveLength(0);
    await expect(monthlyUsage(pool, "not-a-month")).rejects.toThrow(/YYYY-MM/);
  });

  it("buckets daily hours across midnight and month edges", async () => {
    await pool.query("DELETE FROM vm_power_periods WHERE vm_id = $1", [vmId]);
    // 23:00 Jan 10 -> 01:00 Jan 11 splits 1h / 1h across the two days.
    await pool.query(
      "INSERT INTO vm_power_periods (id, vm_id, started_at, ended_at) VALUES ('22222222-2222-4222-8222-222222222222', $1, '2026-01-10T23:00:00Z', '2026-01-11T01:00:00Z')",
      [vmId],
    );
    // Starts in December, ends Jan 1 02:00 -> only 2h lands in January.
    await pool.query(
      "INSERT INTO vm_power_periods (id, vm_id, started_at, ended_at) VALUES ('33333333-3333-4333-8333-333333333333', $1, '2025-12-31T22:00:00Z', '2026-01-01T02:00:00Z')",
      [vmId],
    );
    const days = await dailyUsage(pool, "2026-01");
    expect(days).toHaveLength(31);
    const byDay = new Map(days.map((d) => [d.day, d.hours]));
    expect(byDay.get("2026-01-01")).toBeCloseTo(2, 5);
    expect(byDay.get("2026-01-10")).toBeCloseTo(1, 5);
    expect(byDay.get("2026-01-11")).toBeCloseTo(1, 5);
    expect(byDay.get("2026-01-15")).toBe(0);
    // Day rows sum to the monthly total.
    const total = days.reduce((sum, d) => sum + d.hours, 0);
    const monthly = await monthlyUsage(pool, "2026-01");
    expect(total).toBeCloseTo(monthly[0]!.hours, 2);
    expect(await dailyUsage(pool, "2026-02")).toHaveLength(28);
    await expect(dailyUsage(pool, "junk")).rejects.toThrow(/YYYY-MM/);
  });
});

describe("quotas", () => {
  let ctx: CoreContext;
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMock() as never,
      logger: silentLogger,
    });
    const user = await ctx.users.create({
      username: "quota-user",
      passwordHash: "x".repeat(60),
      roles: ["USER"],
    });
    userId = user.id;
  });

  afterAll(async () => {
    await pool.end().catch(() => undefined);
  });

  it("defaults to unlimited, counts live VMs, validates bounds", async () => {
    expect(await getUserQuota(pool, userId)).toBeNull();
    expect(await countUserVms(pool, userId)).toBe(0);
    await ctx.vms.create({ vmid: 101, node: "n", name: "a", createdByUserId: userId });
    await ctx.vms.create({ vmid: 102, node: "n", name: "b", createdByUserId: userId });
    expect(await countUserVms(pool, userId)).toBe(2);
    expect(await setUserQuota(pool, userId, 2)).toBe(2);
    await expect(setUserQuota(pool, userId, -1)).rejects.toThrow(/non-negative/);
    await expect(setUserQuota(pool, userId, 1.5)).rejects.toThrow(/non-negative/);
    expect(await setUserQuota(pool, userId, null)).toBeNull();
    await expect(setUserQuota(pool, "00000000-0000-0000-0000-000000000000", 1)).rejects.toThrow(/not found/i);
  });
});

describe("support tickets", () => {
  let ctx: CoreContext;
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMock() as never,
      logger: silentLogger,
    });
    const user = await ctx.users.create({
      username: "ticket-user",
      passwordHash: "x".repeat(60),
      roles: ["USER"],
    });
    userId = user.id;
  });

  afterAll(async () => {
    await pool.end().catch(() => undefined);
  });

  it("files, lists, and closes with validation", async () => {
    const ticket = await createTicket(pool, userId, " RDP drops ", "Every evening around 9pm.");
    expect(ticket.title).toBe("RDP drops");
    expect(ticket.status).toBe("open");
    await expect(createTicket(pool, userId, "", "body")).rejects.toThrow(/1–120/);
    await expect(createTicket(pool, userId, "t", "")).rejects.toThrow(/1–4000/);
    expect((await listTickets(pool, { userId })).map((t) => t.id)).toContain(ticket.id);
    const closed = await setTicketStatus(pool, ticket.id, "closed", userId);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).not.toBeNull();
    expect(await listTickets(pool, { status: "open" })).toHaveLength(0);
    await expect(setTicketStatus(pool, ticket.id, "bogus" as never, userId)).rejects.toThrow(/Invalid status/);
    await expect(
      setTicketStatus(pool, "00000000-0000-0000-0000-000000000000", "closed", userId),
    ).rejects.toThrow(/not found/i);
  });

  it("reports queue pressure without fetching rows", async () => {
    const older = await createTicket(pool, userId, "Oldest open", "waiting a while");
    const newer = await createTicket(pool, userId, "Newer open", "just filed");
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    await pool.query("UPDATE support_tickets SET created_at = $2 WHERE id = $1", [older.id, threeDaysAgo]);

    const stats = await ticketQueueStats(pool);
    // The earlier test closed its ticket, so the closed count carries over.
    expect(stats).toMatchObject({ open: 2, closed: 1, total: 3 });
    expect(stats.oldestOpenAt?.getTime()).toBe(threeDaysAgo.getTime());
    expect(newer.createdAt.getTime()).toBeGreaterThan(threeDaysAgo.getTime());

    await setTicketStatus(pool, older.id, "closed", userId);
    await setTicketStatus(pool, newer.id, "closed", userId);
    const cleared = await ticketQueueStats(pool);
    expect(cleared).toMatchObject({ open: 0, closed: 3 });
    expect(cleared.oldestOpenAt).toBeNull();
  });
});

describe("announcements", () => {
  let ctx: CoreContext;
  let pool: Pool;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMock() as never,
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    await pool.end().catch(() => undefined);
  });

  it("is null until set, caps length, clears cleanly", async () => {
    expect(await getAnnouncement(ctx.settings)).toBeNull();
    await setAnnouncement(ctx.settings, "Maintenance Sunday", "warn");
    expect(await getAnnouncement(ctx.settings)).toEqual({ text: "Maintenance Sunday", level: "warn" });
    await setAnnouncement(ctx.settings, "x".repeat(600), "info");
    expect((await getAnnouncement(ctx.settings))?.text).toHaveLength(500);
    await setAnnouncement(ctx.settings, null, "info");
    expect(await getAnnouncement(ctx.settings)).toBeNull();
  });
});
