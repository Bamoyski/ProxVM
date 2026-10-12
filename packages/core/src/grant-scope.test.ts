import { describe, expect, it } from "vitest";
import { mergeGrantScope } from "./index.js";

describe("mergeGrantScope", () => {
  it("new grants take the requested scope as-is", () => {
    expect(mergeGrantScope(null, { protocols: null, expiresAt: null })).toEqual({
      protocols: null,
      expiresAt: null,
    });
    expect(mergeGrantScope(null, { protocols: ["rdp"], expiresAt: "2030-01-01T00:00:00.000Z" })).toEqual({
      protocols: ["rdp"],
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
  });

  it("re-listing preserves scoped protocols and expiries instead of widening", () => {
    const exp = new Date("2030-01-01T00:00:00Z");
    expect(mergeGrantScope({ protocols: ["ssh"], expiresAt: exp }, { protocols: null, expiresAt: null })).toEqual({
      protocols: ["ssh"],
      expiresAt: exp,
    });
    expect(
      mergeGrantScope({ protocols: null, expiresAt: null }, { protocols: ["rdp"], expiresAt: exp.toISOString() }),
    ).toEqual({ protocols: null, expiresAt: null });
  });
});
