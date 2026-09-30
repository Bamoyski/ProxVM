import { describe, expect, it } from "vitest";
import { checkSecurlyBlock, parseSecurlyVerdict, securlyBrokerUrl } from "./index.js";

function mockFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("Securly verdict parsing", () => {
  it("detects DENY and extracts the rule id", () => {
    expect(parseSecurlyVerdict("DENY:999:67109120:-1:-1:-1:-1:1")).toEqual({ status: "blocked", ruleId: "67109120" });
    expect(parseSecurlyVerdict("  DENY:1:2  ")).toEqual({ status: "blocked", ruleId: "2" });
  });
  it("treats anything else as clean", () => {
    expect(parseSecurlyVerdict("SS:999:CC:1:-1:-1:-1:1")).toEqual({ status: "clean", ruleId: null });
    expect(parseSecurlyVerdict("")).toEqual({ status: "clean", ruleId: null });
  });
  it("builds the broker URL keyed by host", () => {
    const url = securlyBrokerUrl("proxvm3.example.org", "student@example.org");
    expect(url).toContain("host=proxvm3.example.org");
    expect(url).toContain("useremail=student%40example.org");
    expect(url).toContain("reason=crextn");
  });
});

describe("Securly block check", () => {
  it("reports blocked / clean / unknown distinctly", async () => {
    const blocked = await checkSecurlyBlock("a.example", "s@example.org", {
      fetchImpl: mockFetch("DENY:999:67109120:-1:-1:-1:-1:1"),
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.ruleId).toBe("67109120");
    expect(blocked.hostname).toBe("a.example");

    const clean = await checkSecurlyBlock("a.example", "s@example.org", {
      fetchImpl: mockFetch("SS:999:CC:1:-1:-1:-1:1"),
    });
    expect(clean.status).toBe("clean");

    const httpErr = await checkSecurlyBlock("a.example", "s@example.org", { fetchImpl: mockFetch("", 500) });
    expect(httpErr.status).toBe("unknown");

    const down = await checkSecurlyBlock("a.example", "s@example.org", {
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(down.status).toBe("unknown");
    expect(down.detail).toContain("ECONNREFUSED");
  });
});
