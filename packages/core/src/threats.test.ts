import { describe, expect, it } from "vitest";
import {
  assertSafeWebhookUrl,
  detectOutOfBand,
  detectThreats,
  evaluateThreatAlerts,
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

  it("stays silent with no webhook configured", async () => {
    const deps = {
      settings: { getPlain: async () => null, set: async () => undefined },
      audit: { list: async () => [] },
    };
    await expect(evaluateThreatAlerts(deps as never, async () => undefined, NOW)).resolves.toEqual({
      evaluated: 0,
      fired: 0,
    });
  });
});
