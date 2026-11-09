import { describe, expect, it } from "vitest";
import { DEFAULT_POLL_CAP_MS, DEFAULT_POLL_MS, backoffInterval } from "./poll.js";

describe("backoffInterval", () => {
  it("keeps the base cadence while healthy", () => {
    expect(backoffInterval(0)).toBe(DEFAULT_POLL_MS);
    expect(backoffInterval(-3)).toBe(DEFAULT_POLL_MS);
    expect(backoffInterval(Number.NaN)).toBe(DEFAULT_POLL_MS);
  });

  it("doubles per consecutive failure and stops at the cap", () => {
    expect(backoffInterval(1)).toBe(60_000);
    expect(backoffInterval(2)).toBe(120_000);
    expect(backoffInterval(3)).toBe(240_000);
    expect(backoffInterval(4)).toBe(DEFAULT_POLL_CAP_MS);
  });

  it("never exceeds the cap no matter how long the outage lasts", () => {
    expect(backoffInterval(5)).toBe(DEFAULT_POLL_CAP_MS);
    expect(backoffInterval(500)).toBe(DEFAULT_POLL_CAP_MS);
  });

  it("honours custom base and cap", () => {
    expect(backoffInterval(0, { baseMs: 1_000, capMs: 8_000 })).toBe(1_000);
    expect(backoffInterval(1, { baseMs: 1_000, capMs: 8_000 })).toBe(2_000);
    expect(backoffInterval(2, { baseMs: 1_000, capMs: 8_000 })).toBe(4_000);
    expect(backoffInterval(3, { baseMs: 1_000, capMs: 8_000 })).toBe(8_000);
    expect(backoffInterval(9, { baseMs: 1_000, capMs: 8_000 })).toBe(8_000);
  });

  it("treats fractional failure counts as whole steps", () => {
    expect(backoffInterval(1.9)).toBe(60_000);
  });
});
