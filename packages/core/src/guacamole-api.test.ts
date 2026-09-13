import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClientLaunchUrl, buildLoginUrl, GuacamoleApiClient } from "./guacamole/api.js";

describe("GuacamoleApiClient error reporting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("transport failures carry no host/URL in the user-facing message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 10.9.8.7:8080");
      }),
    );
    const client = new GuacamoleApiClient("http://10.9.8.7:8080/guacamole");
    let message = "";
    try {
      await client.requestToken("px_bob", "secret");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/Cannot reach the Guacamole web application/);
    expect(message).not.toMatch(/10\.9\.8\.7|https?:\/\//);
  });

  // CodeQL js/polynomial-redos alerts #2-#3: launch/login URL builders must
  // normalize slash-heavy base URLs without regex backtracking.
  it("builds launch and login URLs from slash-heavy base URLs", () => {
    const base = `http://guacamole.example.com/guacamole${"/".repeat(50_000)}`;
    expect(buildLoginUrl(base)).toBe("http://guacamole.example.com/guacamole/");
    expect(buildClientLaunchUrl(base, "42", "tok")).toBe(
      "http://guacamole.example.com/guacamole/#/client/42?token=tok",
    );
  });
});
