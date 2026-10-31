import { describe, it, expect } from "vitest";
import {
  fmtAge,
  matchesThreat,
  matchesTicket,
  oldestOpenAgeMs,
  sortThreats,
  sortTickets,
  ticketCounts,
  urgentCounts,
  waitingTone,
  type ThreatLike,
  type TicketLike,
} from "./triage.js";

/**
 * The admin boards are only as good as their ordering. These tests pin the
 * two claims a reviewer relies on: "critical is always on top" and "the
 * longest-waiting ticket is always first".
 */

const HOUR = 3_600_000;
const now = Date.parse("2026-10-29T12:00:00.000Z");

function threat(over: Partial<ThreatLike> & { title: string }): ThreatLike {
  return {
    severity: "low",
    category: "anomaly",
    summary: "",
    actorUsername: null,
    ip: null,
    events: [],
    lastSeen: "2026-10-29T11:00:00.000Z",
    ...over,
  };
}

function ticket(over: Partial<TicketLike> & { id: string; createdAt: string }): TicketLike {
  return {
    username: "alice",
    title: "vm won't boot",
    body: "cloud-init stuck",
    status: "open",
    ...over,
  };
}

describe("sortThreats", () => {
  const items = [
    threat({ title: "old low", severity: "low", lastSeen: "2026-10-20T00:00:00.000Z" }),
    threat({ title: "new high", severity: "high", lastSeen: "2026-10-29T11:00:00.000Z" }),
    threat({ title: "critical", severity: "critical", lastSeen: "2026-10-25T00:00:00.000Z" }),
    threat({ title: "old high", severity: "high", lastSeen: "2026-10-21T00:00:00.000Z" }),
  ];

  it("puts critical first, then newest within a severity", () => {
    expect(sortThreats(items, "severity").map((f) => f.title)).toEqual([
      "critical",
      "new high",
      "old high",
      "old low",
    ]);
  });

  it("recent mode ignores severity", () => {
    expect(sortThreats(items, "recent").map((f) => f.title)).toEqual([
      "new high",
      "critical",
      "old high",
      "old low",
    ]);
  });

  it("never mutates the caller's array", () => {
    const before = items.map((f) => f.title);
    sortThreats(items, "severity");
    expect(items.map((f) => f.title)).toEqual(before);
  });
});

describe("matchesThreat", () => {
  const f = threat({
    title: "Repeated failed logins",
    category: "brute-force",
    actorUsername: "alice",
    ip: "10.0.0.5",
    events: ["LOGIN_FAILED"],
  });

  it("matches on actor, IP, title and source events", () => {
    expect(matchesThreat(f, "alice")).toBe(true);
    expect(matchesThreat(f, "10.0.0.5")).toBe(true);
    expect(matchesThreat(f, "brute")).toBe(true);
    expect(matchesThreat(f, "login_failed")).toBe(true);
  });

  it("requires every token (narrowing, not widening)", () => {
    expect(matchesThreat(f, "alice 10.0.0.5")).toBe(true);
    expect(matchesThreat(f, "alice 10.0.0.6")).toBe(false);
  });

  it("treats an empty query as no filter", () => {
    expect(matchesThreat(f, "   ")).toBe(true);
  });
});

describe("urgentCounts", () => {
  it("counts critical and high separately from total", () => {
    expect(
      urgentCounts([
        threat({ title: "a", severity: "critical" }),
        threat({ title: "b", severity: "high" }),
        threat({ title: "c", severity: "low" }),
      ]),
    ).toEqual({ critical: 1, high: 1, urgent: 2 });
  });
});

describe("sortTickets", () => {
  const items = [
    ticket({ id: "closed-new", status: "closed", createdAt: "2026-10-28T00:00:00.000Z" }),
    ticket({ id: "open-old", createdAt: "2026-10-20T00:00:00.000Z" }),
    ticket({ id: "open-new", createdAt: "2026-10-27T00:00:00.000Z" }),
    ticket({ id: "answered", status: "answered", createdAt: "2026-10-26T00:00:00.000Z" }),
    ticket({ id: "closed-old", status: "closed", createdAt: "2026-10-01T00:00:00.000Z" }),
  ];

  it("puts the longest-waiting open ticket first and closed last", () => {
    expect(sortTickets(items, "waiting").map((t) => t.id)).toEqual([
      "open-old",
      "open-new",
      "answered",
      "closed-new",
      "closed-old",
    ]);
  });

  it("newest mode orders by last activity", () => {
    expect(sortTickets(items, "newest")[0]!.id).toBe("closed-new");
  });
});

describe("ticketCounts / oldestOpenAgeMs", () => {
  const items = [
    ticket({ id: "a", createdAt: new Date(now - 3 * 24 * HOUR).toISOString() }),
    ticket({ id: "b", createdAt: new Date(now - 5 * 24 * HOUR).toISOString() }),
    ticket({ id: "c", status: "closed", createdAt: new Date(now - 30 * 24 * HOUR).toISOString() }),
    ticket({ id: "d", status: "answered", createdAt: new Date(now - 9 * 24 * HOUR).toISOString() }),
  ];

  it("counts by status including the total", () => {
    expect(ticketCounts(items)).toEqual({ open: 2, answered: 1, closed: 1, total: 4 });
  });

  it("measures only open tickets", () => {
    expect(oldestOpenAgeMs(items, now)).toBe(5 * 24 * HOUR);
    expect(oldestOpenAgeMs([ticket({ id: "closed", status: "closed", createdAt: new Date(now).toISOString() })], now)).toBeNull();
  });
});

describe("matchesTicket", () => {
  const t = ticket({ id: "x", createdAt: new Date(now).toISOString(), username: "bob", body: "RDP dropped after a reboot" });

  it("matches reporter, summary and body", () => {
    expect(matchesTicket(t, "bob")).toBe(true);
    expect(matchesTicket(t, "boot")).toBe(true);
    expect(matchesTicket(t, "rdp reboot")).toBe(true);
  });

  it("rejects unmatched tokens", () => {
    expect(matchesTicket(t, "alice")).toBe(false);
  });
});

describe("waitingTone", () => {
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("escalates at two days and seven days", () => {
    expect(waitingTone(iso(1 * HOUR), now)).toBe("neutral");
    expect(waitingTone(iso(2 * 24 * HOUR), now)).toBe("warn");
    expect(waitingTone(iso(8 * 24 * HOUR), now)).toBe("err");
  });

  it("survives an unparseable timestamp", () => {
    expect(waitingTone("not-a-date", now)).toBe("err");
  });
});

describe("fmtAge", () => {
  it("renders minutes, hours and days", () => {
    expect(fmtAge(45 * 60_000)).toBe("45m");
    expect(fmtAge(6 * HOUR)).toBe("6h");
    expect(fmtAge(3 * 24 * HOUR)).toBe("3d");
    expect(fmtAge(null)).toBe("—");
  });
});
