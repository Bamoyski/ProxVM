import { describe, expect, it } from "vitest";
import { CloudflareClient } from "./cloudflare/client.js";
import { ProxmoxBackupClient } from "./pbs/client.js";
import { normalizeHostname, assertValidHostname } from "./services/domains.js";

// Regression tests for CodeQL js/polynomial-redos alerts #7 (cloudflare),
// #8 (domains), #9 (pbs). Timing budgets are deliberately generous (5s):
// the old patterns needed minutes on these inputs; the fixed code paths
// are linear and finish in milliseconds.

function mockFetch(handler: (url: string) => unknown): typeof fetch {
  return (async (url: unknown) => {
    const result = handler(String(url));
    return new Response(JSON.stringify(result), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("ReDoS regressions: trailing-slash base URLs (#7, #9)", () => {
  it("strips trailing slashes from Cloudflare and PBS base URLs", async () => {
    const seen: string[] = [];
    const cf = new CloudflareClient({
      token: "t",
      baseUrl: "https://api.example.com/v4///",
      fetchImpl: mockFetch((url) => {
        seen.push(url);
        return { result: { id: "x", status: "active" }, success: true };
      }),
    });
    await cf.verifyToken();
    expect(seen[0]).toBe("https://api.example.com/v4/user/tokens/verify");

    const pbs = new ProxmoxBackupClient({
      url: "https://pbs.example:8007//",
      tokenId: "u@pbs!t",
      tokenSecret: "s",
      fetchImpl: mockFetch((url) => {
        seen.push(url);
        return { data: { version: "4.2" } };
      }),
    });
    await pbs.version();
    expect(seen[1]).toBe("https://pbs.example:8007/api2/json/version");
  });

  it("rejects empty PBS url without matching", () => {
    expect(() => new ProxmoxBackupClient({ url: "", tokenId: "a", tokenSecret: "b" })).toThrow(/url is required/);
  });

  it("handles slash-heavy adversarial base URLs in milliseconds", async () => {
    // A long slash run followed by a non-slash is the genuine quadratic
    // case for the old pattern (backtracking over every split point).
    const adversarial = `https://pbs.example:8007/${"/".repeat(50000)}!`;
    const started = Date.now();
    const pbs = new ProxmoxBackupClient({
      url: adversarial,
      tokenId: "u@pbs!t",
      tokenSecret: "s",
      fetchImpl: mockFetch(() => ({ data: { version: "4.2" } })),
    });
    await pbs.version();
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);
});

describe("ReDoS regressions: hostname parsing (#8)", () => {
  it("preserves normalizeHostname behavior on valid inputs", () => {
    expect(normalizeHostname("https://proxvm.example.com:8080/guac")).toBe("proxvm.example.com");
    expect(normalizeHostname("ProxVM.Example.COM:8080")).toBe("proxvm.example.com");
    expect(normalizeHostname("  app.example.com. ")).toBe("app.example.com");
    expect(normalizeHostname("user@app.example.com")).toBe("app.example.com");
    expect(normalizeHostname("[::1]:8080")).toBe("::1");
    expect(normalizeHostname("no-scheme-here")).toBe("no-scheme-here");
    expect(normalizeHostname("")).toBe("");
    // A colon without slashes is treated as a port separator (split at the
    // first colon), exactly as before — "http:example.com" yields "http".
    expect(normalizeHostname("http:example.com")).toBe("http");
    // Leading "://" has an empty first path segment in both old and new code.
    expect(normalizeHostname("://example.com")).toBe("");
    // A scheme must start with a letter; otherwise the colon acts as a
    // port separator — identical in old and new code.
    expect(normalizeHostname("1http://example.com")).toBe("1http");
    expect(normalizeHostname("ht!tp://example.com")).toBe("ht!tp");
  });

  it("preserves assertValidHostname accept/reject behavior", () => {
    expect(() => assertValidHostname("app.example.com")).not.toThrow();
    expect(() => assertValidHostname("a.b")).not.toThrow();
    expect(() => assertValidHostname("xn--nxasmq6b.example.com")).not.toThrow();
    for (const bad of [
      "",
      "nodot",
      "-bad.com",
      "bad-.com",
      "bad..com",
      ".bad.com",
      "bad.com.",
      "UPPER.com",
      "under_score.com",
      "a".repeat(254) + ".com",
      `${"a".repeat(64)}.com`,
    ]) {
      expect(() => assertValidHostname(bad), bad.slice(0, 30)).toThrow(/Invalid domain name/);
    }
    // Boundaries: 253 total chars ok, 63-char label ok.
    const maxHost = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
    expect(maxHost.length).toBeLessThanOrEqual(253);
    expect(() => assertValidHostname(maxHost)).not.toThrow();
  });

  it("handles adversarial near-scheme Host headers in milliseconds", () => {
    // Colon present but :// absent: hostile shape for scheme stripping.
    // No regex touches this input anymore, so matching stays linear.
    // Behavior (truncate at the port colon) is unchanged.
    const adversarial = `${"a".repeat(50000)}:x${"a".repeat(50000)}`;
    const started = Date.now();
    const out = normalizeHostname(adversarial);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out).toBe("a".repeat(50000));
  }, 15000);

  it("handles long slash-heavy and dot-heavy inputs in milliseconds", () => {
    const started = Date.now();
    expect(normalizeHostname(`http://${"a/".repeat(50000)}`)).toBe("a");
    expect(normalizeHostname(`${"a".repeat(200000)}`)).toHaveLength(200000);
    expect(() => assertValidHostname(`${"a".repeat(100000)}!`)).toThrow(/Invalid domain name/);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);
});
