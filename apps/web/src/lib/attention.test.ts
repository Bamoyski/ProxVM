import { describe, it, expect } from "vitest";
import {
  attentionBadges,
  attentionItems,
  threatBreakdown,
  type AttentionResponse,
} from "./attention.js";

/**
 * Badges are the only thing standing between an admin and a quiet sidebar on
 * a system that is on fire. These tests pin: (a) nothing renders when nothing
 * is wrong, (b) critical threats outrank everything, (c) the ticket tone uses
 * the same 7-day rule as the queue itself.
 */

const DAY = 86_400_000;
const now = Date.parse("2026-10-29T12:00:00.000Z");

function attention(over: Partial<AttentionResponse> = {}): AttentionResponse {
  return {
    generatedAt: new Date(now).toISOString(),
    threats: null,
    tickets: null,
    ...over,
  };
}

const clearThreats = { critical: 0, high: 0, medium: 0, low: 0, urgent: 0 };

describe("attentionBadges", () => {
  it("renders nothing when the system is quiet", () => {
    expect(attentionBadges(attention())).toEqual({});
    expect(
      attentionBadges(
        attention({
          threats: clearThreats,
          tickets: { open: 0, answered: 0, closed: 4, oldestOpenAt: null },
        }),
      ),
    ).toEqual({});
  });

  it("uses red for critical threats and amber for high-only", () => {
    const err = attentionBadges(
      attention({ threats: { critical: 1, high: 2, medium: 0, low: 0, urgent: 3 } }),
    )["/system"]!;
    expect(err).toMatchObject({ count: 3, tone: "err" });
    expect(err.title).toContain("3 urgent threat findings");
    expect(err.title).toContain("1 critical, 2 high");

    const warn = attentionBadges(
      attention({ threats: { critical: 0, high: 2, medium: 4, low: 0, urgent: 2 } }),
    )["/system"]!;
    expect(warn).toMatchObject({ count: 2, tone: "warn" });
  });

  it("turns the ticket badge red only once the oldest ticket passes a week", () => {
    const fresh = attentionBadges(
      attention({
        tickets: {
          open: 2,
          answered: 0,
          closed: 0,
          oldestOpenAt: new Date(now - 3 * 3_600_000).toISOString(),
        },
      }),
      now,
    )["/tickets"]!;
    expect(fresh.tone).toBe("warn");
    expect(fresh.title).toContain("2 open tickets");
    expect(fresh.title).toContain("oldest waiting 3h");

    const stale = attentionBadges(
      attention({
        tickets: {
          open: 1,
          answered: 0,
          closed: 0,
          oldestOpenAt: new Date(now - 8 * DAY).toISOString(),
        },
      }),
      now,
    )["/tickets"]!;
    expect(stale).toMatchObject({ count: 1, tone: "err" });
    expect(stale.title).toContain("oldest waiting 8d");
  });

  it("keeps a badge even when the server sent no oldest timestamp", () => {
    const badge = attentionBadges(
      attention({ tickets: { open: 1, answered: 0, closed: 0, oldestOpenAt: null } }),
      now,
    )["/tickets"]!;
    expect(badge).toMatchObject({ count: 1, tone: "warn" });
    expect(badge.title).toBe("1 open ticket");
  });
});

describe("attentionItems", () => {
  it("returns threats before tickets, with the actionable destination", () => {
    const items = attentionItems(
      attention({
        threats: { critical: 0, high: 1, medium: 0, low: 0, urgent: 1 },
        tickets: {
          open: 2,
          answered: 1,
          closed: 0,
          oldestOpenAt: new Date(now - 8 * DAY).toISOString(),
        },
      }),
      now,
    );
    expect(items.map((i) => i.key)).toEqual(["threats", "tickets"]);
    expect(items[0]!.to).toBe("/system?tab=threats");
    expect(items[0]!.title).toBe("1 urgent threat finding to triage");
    expect(items[1]!.to).toBe("/tickets");
    expect(items[1]!.tone).toBe("err");
    expect(items[1]!.detail).toBe("Oldest has waited 8d.");
  });

  it("is empty when both permissions returned null", () => {
    expect(attentionItems(attention())).toEqual([]);
    expect(attentionItems(null)).toEqual([]);
  });
});

describe("threatBreakdown", () => {
  it("lists urgent severities and falls back to the quiet ones", () => {
    expect(threatBreakdown({ critical: 1, high: 0, medium: 3, low: 2, urgent: 1 })).toBe("1 critical");
    expect(threatBreakdown({ critical: 0, high: 0, medium: 3, low: 2, urgent: 0 })).toBe("3 medium, 2 low");
    expect(threatBreakdown(clearThreats)).toBe("");
  });
});
