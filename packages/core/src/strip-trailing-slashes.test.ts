import { describe, expect, it } from "vitest";
import { stripTrailingSlashes } from "./index.js";

// Regression tests for CodeQL js/polynomial-redos alerts #1-#4: the
// `/\/+$/` pattern backtracks quadratically on slash-heavy inputs, so all
// base-URL normalization now goes through this linear-time helper.
describe("stripTrailingSlashes", () => {
  it("strips one or many trailing slashes", () => {
    expect(stripTrailingSlashes("https://pve.example.com:8006")).toBe("https://pve.example.com:8006");
    expect(stripTrailingSlashes("https://pve.example.com:8006/")).toBe("https://pve.example.com:8006");
    expect(stripTrailingSlashes("https://pve.example.com:8006///")).toBe("https://pve.example.com:8006");
    expect(stripTrailingSlashes("http://guacamole.example.com/guacamole//")).toBe(
      "http://guacamole.example.com/guacamole",
    );
  });

  it("leaves interior slashes and empty/all-slash inputs alone", () => {
    expect(stripTrailingSlashes("")).toBe("");
    expect(stripTrailingSlashes("/")).toBe("");
    expect(stripTrailingSlashes("////")).toBe("");
    expect(stripTrailingSlashes("a/b/c")).toBe("a/b/c");
    expect(stripTrailingSlashes("/api/tokens")).toBe("/api/tokens");
  });

  it("matches the old /\\/+$// behavior on every realistic input", () => {
    const cases = [
      "",
      "/",
      "///",
      "https://pve.example.com:8006",
      "https://pve.example.com:8006/",
      "https://pve.example.com:8006////",
      "http://guacamole.example.com:8080/guacamole",
      "http://guacamole.example.com:8080/guacamole/",
      "/api2/json",
      "a/b/c",
    ];
    for (const input of cases) {
      expect(stripTrailingSlashes(input)).toBe(input.replace(/\/+$/, ""));
    }
  });

  it("pins the one degenerate difference: trailing line terminators are not stripped", () => {
    // The old regex anchored `$` before a final newline, producing a URL
    // that still contained "\n". Both forms are invalid base URLs; the
    // helper leaves the input untouched instead of emitting a newline.
    expect(stripTrailingSlashes("https://pve.example.com:8006//\n")).toBe("https://pve.example.com:8006//\n");
  });

  it("stays linear on the adversarial input that broke /\\/+$//", () => {
    const adversarial = `https://pve.example.com:8006${"/".repeat(200_000)}x`;
    const started = Date.now();
    const result = stripTrailingSlashes(adversarial);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toBe(adversarial);
  });
});
