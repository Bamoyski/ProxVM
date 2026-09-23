import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  normalizeHostname,
  resolveDomainRedirect,
  getDomainConfig,
  setCanonicalDomain,
  removeDomainAlias,
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

describe("domain redirect matcher", () => {
  const base = { canonical: "proxvm1.benmoyer.example", aliases: ["proxvm.benmoyer.example"] };
  it("redirects old GET navigations, preserving path and query", () => {
    expect(
      resolveDomainRedirect({ host: "proxvm.benmoyer.example", url: "/vms/123?tab=guac", method: "GET", ...base }),
    ).toBe("https://proxvm1.benmoyer.example/vms/123?tab=guac");
  });
  it("leaves canonical, unknown, and dev hosts alone", () => {
    expect(resolveDomainRedirect({ host: "proxvm1.benmoyer.example", url: "/", method: "GET", ...base })).toBeNull();
    expect(resolveDomainRedirect({ host: "other.example.com", url: "/", method: "GET", ...base })).toBeNull();
    expect(resolveDomainRedirect({ host: "localhost:8080", url: "/", method: "GET", ...base })).toBeNull();
    expect(resolveDomainRedirect({ host: "192.168.1.10", url: "/", method: "GET", ...base })).toBeNull();
    expect(resolveDomainRedirect({ host: undefined, url: "/", method: "GET", ...base })).toBeNull();
    expect(resolveDomainRedirect({ host: "proxvm.benmoyer.example", url: "/", method: "GET", canonical: null, aliases: [] })).toBeNull();
  });
  it("never redirects API traffic except share redemption", () => {
    expect(resolveDomainRedirect({ host: "proxvm.benmoyer.example", url: "/api/vms", method: "GET", ...base })).toBeNull();
    expect(resolveDomainRedirect({ host: "proxvm.benmoyer.example", url: "/api/auth/login", method: "POST", ...base })).toBeNull();
    expect(
      resolveDomainRedirect({ host: "proxvm.benmoyer.example", url: "/api/s/abc123", method: "GET", ...base }),
    ).toBe("https://proxvm1.benmoyer.example/api/s/abc123");
  });
  it("normalizes hosts with ports, case, and schemes", () => {
    expect(normalizeHostname("ProxVM.Benmoyer.Example:8080")).toBe("proxvm.benmoyer.example");
    expect(normalizeHostname("https://proxvm.benmoyer.example/guac")).toBe("proxvm.benmoyer.example");
    expect(
      resolveDomainRedirect({ host: "PROXVM.BENMOYER.EXAMPLE:443", url: "/", method: "GET", ...base }),
    ).toBe("https://proxvm1.benmoyer.example/");
  });
});

describe("canonical domain settings", () => {
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

  it("starts empty, sets canonical, and accumulates old hosts as aliases", async () => {
    expect((await getDomainConfig(ctx.settings)).canonical).toBeNull();
    const first = await setCanonicalDomain(ctx.settings, "https://proxvm.benmoyer.example/");
    expect(first).toEqual({ canonical: "proxvm.benmoyer.example", aliases: [] });
    const second = await setCanonicalDomain(ctx.settings, "proxvm1.benmoyer.example");
    expect(second).toEqual({ canonical: "proxvm1.benmoyer.example", aliases: ["proxvm.benmoyer.example"] });
    // Re-setting the same host is a no-op for aliases.
    const same = await setCanonicalDomain(ctx.settings, "proxvm1.benmoyer.example");
    expect(same.aliases).toEqual(["proxvm.benmoyer.example"]);
    await expect(setCanonicalDomain(ctx.settings, "not a domain!!")).rejects.toThrow(/Invalid domain/);
    await expect(setCanonicalDomain(ctx.settings, "localhost")).rejects.toThrow(/Invalid domain/);
    const removed = await removeDomainAlias(ctx.settings, "proxvm.benmoyer.example");
    expect(removed.aliases).toEqual([]);
  });
});
