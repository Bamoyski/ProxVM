import { describe, expect, it } from "vitest";
import { isLive } from "./services/iam.js";

describe("grant expiry boundary (isLive)", () => {
  it("null/undefined expiry means permanent", () => {
    expect(isLive(null)).toBe(true);
    expect(isLive(undefined)).toBe(true);
  });

  it("future expiry is live, past expiry is dead", () => {
    const now = new Date("2030-06-01T12:00:00.000Z");
    expect(isLive(new Date("2030-06-01T12:00:01.000Z"), now)).toBe(true);
    expect(isLive(new Date("2030-06-01T11:59:59.000Z"), now)).toBe(false);
  });

  it("expiry exactly at now is dead (strictly-greater semantics)", () => {
    const now = new Date("2030-06-01T12:00:00.000Z");
    expect(isLive(new Date(now.getTime()), now)).toBe(false);
    expect(isLive(now.toISOString(), now)).toBe(false);
  });
});
