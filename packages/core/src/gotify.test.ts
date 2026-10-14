import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  alertAdmins,
  clampGotifyPriority,
  getGotifyConfig,
  listNotifications,
  normalizeGotifyBase,
  sendGotifyMessage,
  type CoreContext,
  type LocalConfig,
} from "./index.js";

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

describe("gotify service", () => {
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

  it("normalizes base URLs and clamps priorities", () => {
    expect(normalizeGotifyBase("http://192.168.1.28///")).toBe("http://192.168.1.28");
    expect(normalizeGotifyBase("  http://192.168.1.28/ ")).toBe("http://192.168.1.28");
    // Adversarial slash run: must stay correct (and linear-time — no regex).
    expect(normalizeGotifyBase(`http://192.168.1.28/${"/".repeat(50000)}`)).toBe("http://192.168.1.28");
    expect(normalizeGotifyBase("http://192.168.1.28//path//")).toBe("http://192.168.1.28//path");
    expect(clampGotifyPriority(8)).toBe(8);
    expect(clampGotifyPriority(0)).toBe(0);
    expect(clampGotifyPriority(10)).toBe(10);
    expect(clampGotifyPriority(11)).toBe(5);
    expect(clampGotifyPriority(-1)).toBe(5);
    expect(clampGotifyPriority("bogus")).toBe(5);
    expect(clampGotifyPriority("7")).toBe(7);
  });

  it("is a no-op unless enabled with url + token", async () => {
    let called = 0;
    const post = async (): Promise<void> => {
      called += 1;
    };
    // Fresh settings: disabled, nothing configured.
    await expect(sendGotifyMessage(ctx.settings, { title: "x", message: "y" }, post)).resolves.toEqual({
      sent: false,
    });
    expect(called).toBe(0);
    // Enabled but still missing url/token.
    await ctx.settings.set("notifications.gotify_enabled", "true", { category: "system" });
    await expect(sendGotifyMessage(ctx.settings, { title: "x", message: "y" }, post)).resolves.toEqual({
      sent: false,
    });
    expect(called).toBe(0);
    await ctx.db.query("DELETE FROM settings WHERE key LIKE 'notifications.gotify%'");
  });

  it("posts to <base>/message with token, title, and clamped priority", async () => {
    await ctx.settings.set("notifications.gotify_enabled", "true", { category: "system" });
    await ctx.settings.set("notifications.gotify_url", "http://192.168.1.28/", { category: "system" });
    await ctx.settings.set("notifications.gotify_token", "s3cret-value", { encrypted: true, category: "system" });
    await ctx.settings.set("notifications.gotify_priority", "8", { category: "system" });
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await sendGotifyMessage(
      ctx.settings,
      { title: "VM down", message: "vm1 stopped" },
      async (url, body) => {
        calls.push({ url, body });
      },
    );
    expect(result).toEqual({ sent: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://192.168.1.28/message?token=s3cret-value");
    expect(calls[0]!.body).toMatchObject({ title: "VM down", message: "vm1 stopped", priority: 8 });
    const cfg = await getGotifyConfig(ctx.settings);
    expect(cfg).toMatchObject({ enabled: true, url: "http://192.168.1.28", hasToken: true, priority: 8 });
    await ctx.db.query("DELETE FROM settings WHERE key LIKE 'notifications.gotify%'");
  });

  it("alertAdmins writes the bell row and pushes without throwing", async () => {
    await ctx.settings.set("notifications.gotify_enabled", "true", { category: "system" });
    await ctx.settings.set("notifications.gotify_url", "http://192.168.1.28", { category: "system" });
    await ctx.settings.set("notifications.gotify_token", "s3cret-value", { encrypted: true, category: "system" });
    const calls: Array<{ url: string; body: unknown }> = [];
    await alertAdmins(
      ctx.db,
      ctx.settings,
      silentLogger,
      {
        kind: "system",
        title: "VM test stopped",
        body: "test body",
        link: "/vms/abc",
        priority: 8,
      },
      async (url, body) => {
        calls.push({ url, body });
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://192.168.1.28/message?token=s3cret-value");
    const rows = await listNotifications(ctx.db, { userId: "some-admin", isAdmin: true });
    expect(rows.map((r) => r.title)).toContain("VM test stopped");
    await ctx.db.query("DELETE FROM notifications");
    await ctx.db.query("DELETE FROM settings WHERE key LIKE 'notifications.gotify%'");
  });

  it("alertAdmins survives a failing Gotify post", async () => {
    await ctx.settings.set("notifications.gotify_enabled", "true", { category: "system" });
    await ctx.settings.set("notifications.gotify_url", "http://192.168.1.28", { category: "system" });
    await ctx.settings.set("notifications.gotify_token", "s3cret-value", { encrypted: true, category: "system" });
    const warnings: string[] = [];
    const logger = { warn: (...args: unknown[]): void => void warnings.push(String(args)) } as never;
    await alertAdmins(
      ctx.db,
      ctx.settings,
      logger,
      { title: "boom", body: "down" },
      async () => {
        throw new Error("connection refused");
      },
    );
    // Bell row still written; failure only logged.
    const rows = await listNotifications(ctx.db, { userId: "some-admin", isAdmin: true });
    expect(rows.map((r) => r.title)).toContain("boom");
    expect(warnings.length).toBeGreaterThan(0);
    await ctx.db.query("DELETE FROM notifications");
    await ctx.db.query("DELETE FROM settings WHERE key LIKE 'notifications.gotify%'");
  });
});
