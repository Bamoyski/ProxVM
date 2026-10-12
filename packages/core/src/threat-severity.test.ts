import { describe, expect, it } from "vitest";
import { evaluateThreatAlerts, SEVERITY_RANK } from "./services/threats.js";

const NOW = Date.now();

function row(event: string, opts: { actor: string; minutesAgo: number; ip?: string }) {
  return {
    id: `${event}-${opts.actor}-${opts.minutesAgo}`,
    event,
    actorUserId: "u1",
    actorUsername: opts.actor,
    vmId: null,
    jobId: null,
    ip: opts.ip ?? "203.0.113.9",
    detail: null,
    createdAt: new Date(NOW - opts.minutesAgo * 60_000),
  };
}

describe("threat min_severity validation", () => {
  it("severity ranks order critical above high", () => {
    expect(SEVERITY_RANK.critical).toBeLessThan(SEVERITY_RANK.high);
    expect(SEVERITY_RANK.high).toBeLessThan(SEVERITY_RANK.medium);
    expect(SEVERITY_RANK.medium).toBeLessThan(SEVERITY_RANK.low);
  });

  it("critical-only minimum suppresses high-and-below findings", async () => {
    const posted: unknown[] = [];
    const store = new Map<string, string>([
      ["threats.webhook_url", "https://hooks.example.com/x"],
      ["threats.min_severity", "critical"],
    ]);
    const deps = {
      settings: {
        getPlain: async (k: string) => store.get(k) ?? null,
        set: async () => undefined,
      },
      audit: {
        list: async () => [1, 2, 3, 4, 5].map((m) => row("LOGIN_FAILED", { actor: "bob", minutesAgo: m * 2 })),
      },
    };
    // Five rapid failures from one IP: high severity, not critical.
    const result = await evaluateThreatAlerts(deps as never, async (_u, b) => void posted.push(b), NOW);
    expect(result.fired).toBe(0);
    expect(posted).toHaveLength(0);
  });

  it("unknown stored values fail closed to high", async () => {
    const posted: unknown[] = [];
    const store = new Map<string, string>([
      ["threats.webhook_url", "https://hooks.example.com/x"],
      ["threats.min_severity", "garbage-value"],
    ]);
    const deps = {
      settings: {
        getPlain: async (k: string) => store.get(k) ?? null,
        set: async () => undefined,
      },
      audit: {
        list: async () => [1, 2, 3, 4, 5].map((m) => row("LOGIN_FAILED", { actor: "bob", minutesAgo: m * 2 })),
      },
    };
    const result = await evaluateThreatAlerts(deps as never, async (_u, b) => void posted.push(b), NOW);
    expect(result.fired).toBe(1);
  });
});
