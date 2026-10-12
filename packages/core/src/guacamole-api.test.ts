import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClientLaunchUrl, buildLoginUrl, encodeClientIdentifier, GuacamoleApiClient } from "./guacamole/api.js";

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
    expect(buildClientLaunchUrl(base, "42", "tok", "mysql")).toBe(
      "http://guacamole.example.com/guacamole/#/client/NDIAYwBteXNxbA?token=tok",
    );
  });

  // The web client base64-decodes the `#/client/` segment into
  // `identifier + "\0" + type + "\0" + dataSource`. A raw numeric id decodes
  // to garbage (live incident: id "14" arrived as `×` with type/dataSource
  // `undefined` and every tunnel connect failed with HTTP 400).
  it("encodes client identifiers the way the Guacamole web client decodes them", () => {
    expect(encodeClientIdentifier("14", "mysql")).toBe("MTQAYwBteXNxbA");
    // Round-trip through the web client's own decoding algorithm.
    const fromString = (value: string): { id?: string; type?: string; dataSource?: string } => {
      const padded = value + ["", "===", "==", "="][value.length % 4]!;
      const decoded = Buffer.from(
        padded.replace(/[-_]/g, (h) => ({"-": "+", _: "/"}[h] ?? h)),
        "base64",
      ).toString("binary");
      const [id, type, dataSource] = decoded.split(String.fromCharCode(0));
      return { id, type, dataSource };
    };
    expect(fromString(encodeClientIdentifier("14", "mysql"))).toEqual({
      id: "14",
      type: "c",
      dataSource: "mysql",
    });
    // And the raw numeric id demonstrably does NOT survive that decoding.
    expect(fromString("14").type).toBeUndefined();
  });
});
