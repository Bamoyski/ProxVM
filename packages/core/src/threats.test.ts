import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import {
  assertSafeWebhookUrl,
  detectOutOfBand,
  detectThreats,
  evaluateThreatAlerts,
  findNewIpLogins,
  isSharedEgressIp,
  type ThreatFinding,
} from "./services/threats.js";
import type { AuditRecord } from "@proxvm/shared";

const NOW = new Date("2026-10-06T12:00:00Z").getTime();
let seq = 0;

function row(
  event: string,
  opts: { actor?: string | null; ip?: string | null; minutesAgo?: number; detail?: Record<string, unknown> | null } = {},
): AuditRecord {
  seq += 1;
  return {
    id: `row-${seq}`,
    event: event as AuditRecord["event"],
    actorUserId: opts.actor ? `user-${opts.actor}` : null,
    actorUsername: opts.actor ?? null,
    vmId: null,
    jobId: null,
    ip: opts.ip ?? null,
    detail: opts.detail ?? null,
    createdAt: new Date(NOW - (opts.minutesAgo ?? 5) * 60000),
  };
}

function byId(findings: ThreatFinding[], id: string): ThreatFinding | undefined {
  return findings.find((f) => f.id === id);
}

describe("detectThreats", () => {
  it("flags 5 rapid failures on one account, ignores slow drips", () => {
    const rows = [1, 2, 3, 4, 5].map((m) => row("LOGIN_FAILED", { actor: "bob", ip: "10.0.0.1", minutesAgo: m * 2 }));
    const findings = detectThreats(rows, NOW);
    const f = byId(findings, "brute-force-account-bob");
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("high");
    expect(f!.count).toBe(5);

    const slow = [0, 60, 120, 180, 240].map((m) => row("LOGIN_FAILED", { actor: "bob", minutesAgo: m }));
    expect(byId(detectThreats(slow, NOW), "brute-force-account-bob")).toBeUndefined();

    const few = [1, 2, 3, 4].map((m) => row("LOGIN_FAILED", { actor: "bob", minutesAgo: m }));
    expect(byId(detectThreats(few, NOW), "brute-force-account-bob")).toBeUndefined();
  });

  it("flags password spraying across accounts from one IP", () => {
    const rows = ["a", "b", "c"].flatMap((u, i) =>
      [1, 2].map((k) => row("LOGIN_FAILED", { actor: `${u}${k}`, ip: "10.0.0.9", minutesAgo: i * 3 + k })),
    );
    const findings = detectThreats(rows, NOW);
    const f = byId(findings, "password-spray-10-0-0-9");
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("high");
  });

  it("escalates to critical on success from an attacking IP", () => {
    const rows = [
      ...[1, 2, 3, 4, 5].map((m) => row("LOGIN_FAILED", { actor: "victim", ip: "10.7.7.7", minutesAgo: m * 2 })),
      row("LOGIN", { actor: "victim", ip: "10.7.7.7", minutesAgo: 1 }),
    ];
    const f = byId(detectThreats(rows, NOW), "compromised-login-victim-10-7-7-7");
    expect(f?.severity).toBe("critical");
    expect(f?.events).toEqual(expect.arrayContaining(["LOGIN", "LOGIN_FAILED"]));

    const clean = [
      ...[1, 2, 3, 4, 5].map((m) => row("LOGIN_FAILED", { actor: "victim", ip: "10.7.7.7", minutesAgo: m * 2 })),
      row("LOGIN", { actor: "victim", ip: "10.7.7.8", minutesAgo: 1 }),
    ];
    expect(detectThreats(clean, NOW).some((x) => x.severity === "critical")).toBe(false);
  });

  it("surfaces lockout and disabled-account probes", () => {
    const rows = [
      row("LOGIN_FAILED", { actor: "alice", detail: { reason: "account-locked" } }),
      row("LOGIN_FAILED", { actor: "ghost", detail: { reason: "account-disabled" } }),
    ];
    const findings = detectThreats(rows, NOW);
    expect(byId(findings, "locked-probe-account-locked-alice")?.severity).toBe("medium");
    expect(byId(findings, "locked-probe-account-disabled-ghost")?.severity).toBe("medium");
  });

  it("tracks privilege grants, louder off-hours", () => {
    const rows = [row("ROLE_ASSIGNED", { actor: "admin", minutesAgo: 60 })];
    const findings = detectThreats(rows, NOW);
    expect(byId(findings, "privilege-grants-admin")?.severity).toBe("low");

    // 02:30 UTC off-hours grant
    const night = new Date("2026-10-06T02:30:00Z").getTime();
    const nightRows = [{ ...row("ROLE_ASSIGNED", { actor: "admin" }), createdAt: new Date(night) }];
    expect(byId(detectThreats(nightRows, NOW), "privilege-grants-admin")?.severity).toBe("medium");
  });

  it("ignores non-elevating user creation", () => {
    const rows = [row("USER_CREATED", { actor: "admin", detail: { username: "x", role: "USER" } })];
    expect(detectThreats(rows, NOW)).toHaveLength(0);
  });

  it("flags bulk credential reads", () => {
    const rows = [1, 2, 3, 4, 5].map((m) => row("PASSWORD_REVEALED", { actor: "mallory", minutesAgo: m * 10 }));
    const f = byId(detectThreats(rows, NOW), "mass-secret-access-mallory");
    expect(f?.severity).toBe("medium");

    const few = [1, 2, 3, 4].map((m) => row("PASSWORD_REVEALED", { actor: "mallory", minutesAgo: m * 10 }));
    expect(byId(detectThreats(few, NOW), "mass-secret-access-mallory")).toBeUndefined();
  });

  it("flags firewall weakening but not hardening, and deletions as low", () => {
    const rows = [
      row("VM_FIREWALL_CHANGED", { actor: "admin", detail: { isolated: false } }),
      row("VM_DELETED", { actor: "admin" }),
    ];
    const findings = detectThreats(rows, NOW);
    expect(byId(findings, "firewall-weakened-admin")?.severity).toBe("medium");
    expect(byId(findings, "vm-deletions-admin")?.severity).toBe("low");

    const harden = [row("VM_FIREWALL_CHANGED", { actor: "admin", detail: { isolated: true } })];
    expect(byId(detectThreats(harden, NOW), "firewall-weakened-admin")).toBeUndefined();
  });

  it("drops rows outside the window", () => {
    const rows = [1, 2, 3, 4, 5].map((m) => row("LOGIN_FAILED", { actor: "bob", minutesAgo: m * 2 + 8 * 24 * 60 }));
    expect(detectThreats(rows, NOW)).toHaveLength(0);
  });

  it("surfaces scan bursts, louder for authenticated probing", () => {
    const anon = [
      row("SCAN_DETECTED", { ip: "10.9.9.9", detail: { count: 25, method: "GET", path: "/api/xyz" } }),
    ];
    expect(byId(detectThreats(anon, NOW), "recon-scan-10-9-9-9")?.severity).toBe("medium");

    const insider = [
      row("SCAN_DETECTED", { actor: "mallory", ip: "10.9.9.8", detail: { count: 30, method: "GET", path: "/api/admin" } }),
    ];
    const f = byId(detectThreats(insider, NOW), "recon-scan-10-9-9-8");
    expect(f?.severity).toBe("high");
    expect(f?.actorUsername).toBe("mallory");
  });

  it("flags guests running with no ProxVM start on record", () => {
    const startedId = "vm-started-id";
    const rows = [row("VM_STARTED", { actor: "admin", minutesAgo: 60 })];
    rows[0]!.vmId = startedId;
    const live = [
      { vmId: startedId, vmid: 101, node: "n1", running: true },
      { vmId: "vm-ghost-id", vmid: 102, node: "n1", running: true },
      { vmId: "vm-stopped-id", vmid: 103, node: "n1", running: false },
      { vmId: null, vmid: 104, node: "n1", running: true },
    ];
    const findings = detectOutOfBand(rows, live, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("out-of-band-102");
    expect(findings[0]!.severity).toBe("medium");
  });

  it("rejects unsafe webhook URLs", () => {
    expect(assertSafeWebhookUrl("https://hooks.example.com/x")).toBe("https://hooks.example.com/x");
    expect(assertSafeWebhookUrl("http://192.168.1.5:9000/hook")).toBe("http://192.168.1.5:9000/hook");
    expect(() => assertSafeWebhookUrl("ftp://x/y")).toThrow(/http/);
    expect(() => assertSafeWebhookUrl("http://169.254.169.254/latest")).toThrow(/metadata/);
    expect(() => assertSafeWebhookUrl("not a url")).toThrow(/valid/);
  });

  it("blocks loopback/link-local in every textual form, allows LAN", () => {
    for (const bad of [
      "http://2130706433/x",
      "http://0x7f.0.0.1/x",
      "http://0177.0.0.1/x",
      "http://127.1/x",
      "http://0.0.0.0/x",
      "http://[::1]/x",
      "http://[::ffff:127.0.0.1]/x",
      "http://localhost/x",
      "http://169.254.169.254.nip.io/x",
    ]) {
      expect(() => assertSafeWebhookUrl(bad), bad).toThrow();
    }
    expect(assertSafeWebhookUrl("http://10.9.9.9:9000/hook")).toBe("http://10.9.9.9:9000/hook");
    expect(assertSafeWebhookUrl("https://hooks.example.com/x")).toBe("https://hooks.example.com/x");
  });

  it("posts fresh findings once, then dedupes", async () => {
    const posted: Array<{ url: string; body: unknown }> = [];
    const post = async (url: string, body: unknown) => {
      posted.push({ url, body });
    };
    const store = new Map<string, string>([
      ["threats.webhook_url", "https://hooks.example.com/x"],
      ["threats.min_severity", "high"],
    ]);
    const deps = {
      settings: {
        getPlain: async (k: string) => store.get(k) ?? null,
        set: async (k: string, v: string) => {
          store.set(k, v);
        },
      },
      audit: {
        list: async () => [1, 2, 3, 4, 5].map((m) => row("LOGIN_FAILED", { actor: "bob", minutesAgo: m * 2 })),
      },
    };
    const first = await evaluateThreatAlerts(deps as never, post, NOW);
    expect(first.fired).toBe(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("https://hooks.example.com/x");

    const second = await evaluateThreatAlerts(deps as never, post, NOW);
    expect(second).toMatchObject({ evaluated: 1, fired: 0 });
    expect(posted).toHaveLength(1);
  });

  it("stays silent with no webhook configured and nothing to report", async () => {
    const deps = {
      settings: { getPlain: async () => null, set: async () => undefined },
      audit: { list: async () => [] },
    };
    await expect(evaluateThreatAlerts(deps as never, async () => undefined, NOW)).resolves.toEqual({
      evaluated: 0,
      fired: 0,
      fresh: [],
      webhookSkipped: false,
    });
  });

  it("still surfaces fresh findings in-app when no webhook is configured", async () => {
    // The bell must not depend on a webhook: detection reaching an admin is
    // the point, delivery channel is a detail.
    const posted: unknown[] = [];
    const store = new Map<string, string>();
    const deps = {
      settings: {
        getPlain: async (k: string) => store.get(k) ?? null,
        set: async (k: string, v: string) => {
          store.set(k, v);
        },
      },
      audit: {
        list: async () => [1, 2, 3, 4, 5].map((m) => row("LOGIN_FAILED", { actor: "bob", minutesAgo: m * 2 })),
      },
    };
    const first = await evaluateThreatAlerts(deps as never, async (url: string) => { posted.push(url); }, NOW);
    expect(first.fired).toBe(1);
    expect(first.fresh).toHaveLength(1);
    expect(first.fresh[0]!.severity === "critical" || first.fresh[0]!.severity === "high").toBe(true);
    expect(posted).toHaveLength(0);
    expect(store.has("threats.alerted_ids")).toBe(true);

    // Same finding on the next tick is not re-announced.
    const second = await evaluateThreatAlerts(deps as never, async (url: string) => { posted.push(url); }, NOW);
    expect(second).toMatchObject({ fired: 0, fresh: [] });
  });

  it("skips an unsafe webhook URL but keeps evaluating findings", async () => {
    const store = new Map<string, string>([["threats.webhook_url", "http://169.254.169.254/latest"]]);
    const deps = {
      settings: {
        getPlain: async (k: string) => store.get(k) ?? null,
        set: async (k: string, v: string) => {
          store.set(k, v);
        },
      },
      audit: {
        list: async () => [1, 2, 3, 4, 5].map((m) => row("LOGIN_FAILED", { actor: "bob", minutesAgo: m * 2 })),
      },
    };
    const result = await evaluateThreatAlerts(deps as never, async () => undefined, NOW);
    expect(result.webhookSkipped).toBe(true);
    expect(result.fired).toBe(1);
  });
});

describe("shared egress addresses", () => {
  const EGRESS = ["172.16.0.0/12", "192.168.1.138"];

  it("matches hosts, IPv4 CIDRs, and IPv6 host routes; ignores malformed entries", () => {
    expect(isSharedEgressIp("192.168.1.138", EGRESS)).toBe(true);
    expect(isSharedEgressIp("172.20.1.1", ["172.16.0.0/12"])).toBe(true);
    expect(isSharedEgressIp("172.32.0.1", ["172.16.0.0/12"])).toBe(false);
    expect(isSharedEgressIp("10.0.0.5", ["10.0.0.5"])).toBe(true);
    expect(isSharedEgressIp("::1", ["::1/128"])).toBe(true);
    expect(isSharedEgressIp("10.0.0.7", ["not-an-ip", "10.0.0.0/33", ""])).toBe(false);
  });

  it("suppresses per-IP rules but keeps per-account bursts for the tunnel hop", () => {
    // The production pattern: several users' failures plus a success, all
    // recorded as one cloudflared egress hop.
    const rows = [
      ...[1, 2, 3, 4, 5, 6].map((m) => row("LOGIN_FAILED", { actor: "spray-a", ip: "192.168.1.138", minutesAgo: m })),
      ...[1, 2, 3, 4, 5, 6].map((m) => row("LOGIN_FAILED", { actor: "spray-b", ip: "192.168.1.138", minutesAgo: m })),
      ...[1, 2, 3, 4, 5, 6].map((m) => row("LOGIN_FAILED", { actor: "spray-c", ip: "192.168.1.138", minutesAgo: m })),
      row("LOGIN", { actor: "admin", ip: "192.168.1.138", minutesAgo: 0 }),
      row("SCAN_DETECTED", { ip: "192.168.1.138", detail: { count: 25, method: "GET", path: "/api/x" } }),
    ];
    const findings = detectThreats(rows, NOW, { sharedEgressIps: EGRESS });

    // No spray, no "compromised" critical, no recon scan from the hop...
    expect(findings.some((f) => f.id.startsWith("password-spray-"))).toBe(false);
    expect(findings.some((f) => f.id.startsWith("compromised-login-"))).toBe(false);
    expect(findings.some((f) => f.id.startsWith("recon-scan-"))).toBe(false);
    expect(findings.some((f) => f.severity === "critical")).toBe(false);

    // ...but the account-scoped burst still fires, with the hop scrubbed.
    const burst = byId(findings, "brute-force-account-spray-a");
    expect(burst?.severity).toBe("high");
    expect(burst?.ip).toBeNull();
    expect(burst?.summary).not.toContain("192.168.1.138");

    // Control: without the egress list the same rows fire spray + critical.
    const raw = detectThreats(rows, NOW);
    expect(byId(raw, "password-spray-192-168-1-138")).toBeTruthy();
    expect(byId(raw, "compromised-login-admin-192-168-1-138")?.severity).toBe("critical");
  });

  it("matches CIDR entries and leaves real client IPs on the hook", () => {
    const rows = [
      ...[1, 2, 3, 4, 5].map((m) => row("LOGIN_FAILED", { actor: "bob", ip: "172.20.4.7", minutesAgo: m })),
      row("LOGIN", { actor: "bob", ip: "172.20.4.7", minutesAgo: 0 }),
      ...[11, 12, 13, 14, 15].map((m) => row("LOGIN_FAILED", { actor: "eve", ip: "203.0.113.9", minutesAgo: m })),
      row("LOGIN", { actor: "eve", ip: "203.0.113.9", minutesAgo: 0 }),
    ];
    const findings = detectThreats(rows, NOW, { sharedEgressIps: EGRESS });
    expect(findings.some((f) => f.ip === "172.20.4.7")).toBe(false);
    expect(byId(findings, "compromised-login-eve-203-0-113-9")?.severity).toBe("critical");
  });

  it("never webhook-alerts on shared-egress-only correlations", async () => {
    const posted: unknown[] = [];
    const store = new Map<string, string>([
      ["threats.webhook_url", "https://hooks.example.com/x"],
      ["threats.min_severity", "high"],
    ]);
    const rows = [
      ...[1, 2].flatMap((i) =>
        [1, 2].map((k) => row("LOGIN_FAILED", { actor: `u${i}${k}`, ip: "192.168.1.138", minutesAgo: i * 2 + k })),
      ),
      row("LOGIN_FAILED", { actor: "u30", ip: "192.168.1.138", minutesAgo: 6 }),
      row("LOGIN", { actor: "u11", ip: "192.168.1.138", minutesAgo: 0 }),
    ];
    const deps = {
      settings: {
        getPlain: async (k: string) => store.get(k) ?? null,
        set: async (k: string, v: string) => {
          store.set(k, v);
        },
      },
      audit: { list: async () => rows },
      sharedEgressIps: ["192.168.1.138"],
    };
    // Spray/critical would fire on these rows without the egress list; with
    // it, no per-account rule reaches 5 failures, so nothing is posted.
    const result = await evaluateThreatAlerts(deps as never, async (_u, b) => void posted.push(b), NOW);
    expect(result).toEqual({ evaluated: 0, fired: 0, fresh: [], webhookSkipped: false });
    expect(posted).toHaveLength(0);
  });
});

describe("findNewIpLogins with shared egress", () => {
  let pool: Pool;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mem = newDb();
    mem.public.none("CREATE TABLE audit_logs (event text, actor_username text, ip text, created_at timestamptz)");
    const { Pool: MemPool } = mem.adapters.createPg();
    pool = new MemPool() as unknown as Pool;
    cleanup = async () => {
      await pool.end().catch(() => undefined);
    };
    const at = new Date(Date.now() - 3600000);
    const insert = (actor: string, ip: string) =>
      pool.query("INSERT INTO audit_logs (event, actor_username, ip, created_at) VALUES ('LOGIN', $1, $2, $3)", [
        actor,
        ip,
        at,
      ]);
    await insert("admin", "192.168.1.138");
    await insert("carol", "203.0.113.5");
  });

  afterAll(async () => {
    await cleanup();
  });

  it("skips egress hops but still flags first logins from real addresses", async () => {
    const unfiltered = await findNewIpLogins(pool, 7);
    expect(unfiltered.map((f) => f.id)).toEqual(
      expect.arrayContaining(["new-ip-admin-192-168-1-138", "new-ip-carol-203-0-113-5"]),
    );

    const filtered = await findNewIpLogins(pool, 7, { sharedEgressIps: ["172.16.0.0/12", "192.168.1.138"] });
    const ids = filtered.map((f) => f.id);
    expect(ids).not.toContain("new-ip-admin-192-168-1-138");
    expect(ids).toContain("new-ip-carol-203-0-113-5");
  });
});
