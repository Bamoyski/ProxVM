import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import {
  AutoRotateOpts,
  createCore,
  makeLogger,
  nextRotatedHostname,
  parseSecurlyVerdict,
  runFilterRotatePass,
  setCanonicalDomain,
  AppError,
  type CoreContext,
  type FilterCheckResult,
  type LocalConfig,
} from "@proxvm/core";
import RedisMockCtor from "ioredis-mock";

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
    masterKey: "e".repeat(64),
  },
};

const num = (host: string): number => Number(host.match(/(\d+)/)?.[1] ?? 0);

function verdictOf(host: string, status: "blocked" | "clean"): FilterCheckResult {
  const body = status === "blocked" ? "DENY:999:67109120:-1:-1:-1:-1:1" : "SS:999:CC:1:-1:-1:-1:1";
  const parsed = parseSecurlyVerdict(body);
  return { status: parsed.status, hostname: host, verdict: body, ruleId: parsed.ruleId, detail: "mock verdict" };
}

/** Broker stub: verdicts keyed by hostname, default for unlisted names. */
function checkOf(map: Record<string, "blocked" | "clean">, fallback: "blocked" | "clean" | "unknown") {
  return async (host: string, _email: string): Promise<FilterCheckResult> => {
    if (fallback === "unknown" && map[host] === undefined) {
      return { status: "unknown", hostname: host, verdict: null, ruleId: null, detail: "broker HTTP 503" };
    }
    return verdictOf(host, map[host] ?? (fallback as "blocked" | "clean"));
  };
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

describe("Securly auto-rotate pass", () => {
  let ctx: CoreContext;
  let pool: unknown;
  let verifyDomainResult = { dnsOk: true, httpsOk: true, detail: "test stub" };

  const cfCalls: string[] = [];
  const tunnelIngress: Array<{ hostname?: string; service: string }> = [
    { hostname: "proxvm6.zone.example", service: "http://localhost:8080" },
    { service: "http_status:404" },
  ];
  const records: Array<{ id: string; type: string; name: string; content: string; proxied: boolean; ttl: number }> = [
    { id: "r-6", type: "A", name: "proxvm6.zone.example", content: "203.0.113.10", proxied: true, ttl: 1 },
  ];
  const fakeCf = {
    getZone: async (zoneId: string) => {
      if (zoneId !== "zone-1") throw Object.assign(new Error("not found"), { statusCode: 404 });
      return { id: "zone-1", name: "zone.example", status: "active" };
    },
    listDnsRecords: async () => {
      cfCalls.push("list");
      return [...records];
    },
    createDnsRecord: async (_zone: string, r: { type: string; name: string; content: string; proxied?: boolean; ttl?: number }) => {
      cfCalls.push(`create:${r.name}`);
      const created = { id: `r-${records.length + 1}`, type: r.type, name: r.name, content: r.content, proxied: r.proxied ?? true, ttl: r.ttl ?? 1 };
      records.push(created);
      return created;
    },
    updateDnsRecord: async (_zone: string, id: string, patch: { content?: string; proxied?: boolean }) => {
      cfCalls.push(`update:${id}`);
      const rec = records.find((r) => r.id === id)!;
      if (patch.content !== undefined) rec.content = patch.content;
      if (patch.proxied !== undefined) rec.proxied = patch.proxied;
      return { ...rec };
    },
    listTunnels: async () => [{ id: "tun-1", name: "homelab", status: "healthy" }],
    getTunnelIngress: async () => ({
      ingress: [...tunnelIngress],
      raw: { ingress: [...tunnelIngress] },
    }),
    putTunnelIngress: async (_a: string, _t: string, _base: unknown, ingress: Array<{ hostname?: string; service: string }>) => {
      cfCalls.push(`ingress:put:${ingress.map((r) => r.hostname ?? "(catch-all)").join(",")}`);
      tunnelIngress.splice(0, tunnelIngress.length, ...ingress.map((r) => ({ ...r })));
    },
  };

  const rotateDeps = () => ({
    settings: ctx.settings,
    redis: ctx.redis as never,
    getCloudflareClient: ctx.getCloudflareClient,
    verifyDomain: ctx.verifyDomain,
    audit: ctx.audit,
    db: ctx.db,
    logger: ctx.logger,
  });

  /** The canonical name is always blocked; any strictly-higher number is clean. */
  const blockedCanonicalDynamic = async (host: string): Promise<FilterCheckResult> => {
    const canonical = (await ctx.settings.getPlain("app.canonical_domain")) ?? "proxvm0.zone.example";
    return num(host) > num(canonical) ? verdictOf(host, "clean") : verdictOf(host, "blocked");
  };

  const clearCooldown = async (): Promise<void> => {
    await ctx.redis.del("proxvm:auto-rotate:cooldown");
  };

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    pool = new MemPool() as unknown as Pool;
    const base = await createCore(localConfig, {
      db: pool as Pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    ctx = {
      ...base,
      getCloudflareClient: async () => fakeCf as never,
      verifyDomain: async () => ({ ...verifyDomainResult }),
    };
    await ctx.settings.set("cloudflare.api_token", "cf-token", { encrypted: true, category: "infrastructure" });
    await ctx.settings.set("cloudflare.zone_id", "zone-1", { category: "infrastructure" });
    await ctx.settings.set("cloudflare.account_id", "acct-1", { category: "infrastructure" });
    await ctx.settings.set("cloudflare.tunnel_id", "tun-1", { category: "infrastructure" });
    await setCanonicalDomain(ctx.settings, "proxvm6.zone.example");
    await ctx.settings.set("securly.useremail", "student@school.example.org", { category: "system" });
  });

  afterAll(async () => {
    await (pool as { end?: () => Promise<void> }).end?.();
  });

  const run = (opts?: AutoRotateOpts) => runFilterRotatePass(rotateDeps(), opts);

  it("does nothing while disabled", async () => {
    const res = await run({ check: checkOf({ "proxvm6.zone.example": "blocked" }, "clean") });
    expect(res.outcome).toBe("disabled");
    expect(cfCalls).toEqual([]);
  });

  it("reports clean without touching Cloudflare", async () => {
    await ctx.settings.set("domains.auto_rotate", "true", { category: "system" });
    const res = await run({ check: checkOf({}, "clean") });
    expect(res.outcome).toBe("clean");
    expect(cfCalls).toEqual([]);
  });

  it("never rotates on an unknown broker verdict for the canonical", async () => {
    const res = await run({ check: checkOf({}, "unknown") });
    expect(res.outcome).toBe("unknown");
    expect(cfCalls).toEqual([]);
  });

  it("bails early when no Securly identity is configured", async () => {
    await ctx.settings.set("securly.useremail", "", { category: "system" });
    const res = await run({ check: checkOf({ "proxvm6.zone.example": "blocked" }, "clean") });
    expect(res.outcome).toBe("no-useremail");
    await ctx.settings.set("securly.useremail", "student@school.example.org", { category: "system" });
  });

  it("rotates on DENY to the next clean number, exact same flow as manual Switch", async () => {
    const res = await run({ check: checkOf({ "proxvm6.zone.example": "blocked" }, "clean") });
    expect(res).toMatchObject({ outcome: "rotated", from: "proxvm6.zone.example", to: "proxvm7.zone.example", ruleId: "67109120" });
    // Canonical flipped, old host parked as alias.
    const canonical = await ctx.settings.getPlain("app.canonical_domain");
    const aliases = JSON.parse((await ctx.settings.getPlain("app.domain_aliases")) ?? "[]") as string[];
    expect(canonical).toBe("proxvm7.zone.example");
    expect(aliases).toContain("proxvm6.zone.example");
    // DNS record cloned from the current one (target + proxied), not hand-made.
    expect(cfCalls).toContain("create:proxvm7.zone.example");
    const created = records.find((r) => r.name === "proxvm7.zone.example");
    expect(created).toMatchObject({ type: "A", content: "203.0.113.10", proxied: true });
    // Tunnel route ensured before the flip; catch-all stays last.
    expect(cfCalls.some((c) => c.startsWith("ingress:put:") && c.includes("proxvm7.zone.example"))).toBe(true);
    expect(tunnelIngress[tunnelIngress.length - 1]).toMatchObject({ service: "http_status:404" });
    // Admin alert + dedup state.
    const alerts = await ctx.db.query<{ title: string }>("SELECT title FROM notifications ORDER BY created_at DESC LIMIT 1");
    expect(alerts.rows[0]?.title).toContain("auto-rotated");
    expect(Number(await ctx.redis.get(`proxvm:auto-rotate:count:${dayKey()}`))).toBe(1);
    expect(await ctx.redis.get("proxvm:auto-rotate:cooldown")).toBeTruthy();
  });

  it("cooldown gates the next tick even while still blocked", async () => {
    const cfCallsBefore = cfCalls.length;
    const res = await run({ check: blockedCanonicalDynamic });
    expect(res.outcome).toBe("cooldown");
    // The cooldown gate is checked before any Cloudflare interaction.
    expect(cfCalls.length).toBe(cfCallsBefore);
  });

  it("aborts without flipping when the DNS verify gate fails", async () => {
    await clearCooldown();
    verifyDomainResult = { dnsOk: false, httpsOk: false, detail: "dns: no addresses returned; https: not probed" };
    try {
      const res = await run({ check: blockedCanonicalDynamic });
      expect(res.outcome).toBe("aborted");
      // Nothing flipped; the record save did not consume the daily budget.
      expect(await ctx.settings.getPlain("app.canonical_domain")).toBe("proxvm7.zone.example");
      expect(Number(await ctx.redis.get(`proxvm:auto-rotate:count:${dayKey()}`))).toBe(1);
    } finally {
      verifyDomainResult = { dnsOk: true, httpsOk: true, detail: "test stub" };
    }
  });

  it("stops at the daily cap and alerts exactly once", async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 7; i++) {
      await clearCooldown();
      const res = await run({ check: blockedCanonicalDynamic });
      outcomes.push(res.outcome);
      if (res.outcome === "capped") break;
    }
    expect(outcomes).toEqual(["rotated", "rotated", "rotated", "rotated", "capped"]);
    // 5 successes total for the day (1 from the first test + 4 here).
    expect(Number(await ctx.redis.get(`proxvm:auto-rotate:count:${dayKey()}`))).toBe(5);
    const capped = await ctx.db.query<{ title: string }>(
      "SELECT title FROM notifications WHERE title LIKE 'Auto-rotate paused%'",
    );
    expect(capped.rows).toHaveLength(1);
    const canonical = await ctx.settings.getPlain("app.canonical_domain");
    expect(num(canonical ?? "0")).toBe(11); // 7 → 8 → 9 → 10 → 11 (cap = 5 total for the day)
  });

  it("refuses blind rotation when every next name is blocked too", async () => {
    await clearCooldown();
    const res = await run({ check: async () => verdictOfWithCurrentBlocked(), maxPerDay: 1000 });
    expect(res.outcome).toBe("no-clean-candidate");
    expect(await ctx.settings.getPlain("app.canonical_domain")).toBe("proxvm11.zone.example");

    async function verdictOfWithCurrentBlocked(): Promise<FilterCheckResult> {
      const canonical = (await ctx.settings.getPlain("app.canonical_domain")) ?? "proxvm0.zone.example";
      return verdictOf(canonical, "blocked");
    }
  });

  it("pauses instead of switching blind when the broker goes dark mid-probe", async () => {
    await clearCooldown();
    const res = await run({ check: async (host) => {
      const canonical = (await ctx.settings.getPlain("app.canonical_domain")) ?? "proxvm0.zone.example";
      if (host === canonical) return verdictOf(host, "blocked");
      return { status: "unknown", hostname: host, verdict: null, ruleId: null, detail: "broker HTTP 503" };
    }, maxPerDay: 1000 });
    expect(res.outcome).toBe("broker-down");
    expect(await ctx.settings.getPlain("app.canonical_domain")).toBe("proxvm11.zone.example");
    const paused = await ctx.db.query<{ title: string }>(
      "SELECT title FROM notifications WHERE title LIKE '%unclear answers%'",
    );
    expect(paused.rows).toHaveLength(1);
  });

  it("hard-fails (cooldown + alert) on infrastructure errors without flipping", async () => {
    await clearCooldown();
    const originalClient = ctx.getCloudflareClient;
    ctx.getCloudflareClient = async () => {
      throw new AppError("EXTERNAL_SERVICE_ERROR", "Cloudflare API error (HTTP 500): internal", 500);
    };
    try {
      const res = await run({ check: blockedCanonicalDynamic, maxPerDay: 1000 });
      expect(res.outcome).toBe("failed");
      expect(await ctx.settings.getPlain("app.canonical_domain")).toBe("proxvm11.zone.example");
      expect(Number(await ctx.redis.get(`proxvm:auto-rotate:count:${dayKey()}`))).toBe(5);
      const failed = await ctx.db.query<{ title: string }>(
        "SELECT title FROM notifications WHERE title = 'Domain auto-rotate failed'",
      );
      expect(failed.rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      ctx.getCloudflareClient = originalClient;
    }
  });

  it("nextRotatedHostname skips already-rotated numbers", async () => {
    const used = ["proxvm7.zone.example", "proxvm8.zone.example", "proxvm9.zone.example", "proxvm10.zone.example", "proxvm11.zone.example", "proxvm12.zone.example"];
    expect(nextRotatedHostname("proxvm12.zone.example", used)).toBe("proxvm13.zone.example");
  });
});
