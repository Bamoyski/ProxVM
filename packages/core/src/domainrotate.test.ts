import { describe, expect, it } from "vitest";
import { bumpHostname, nextRotatedHostname, qualifyName } from "./index.js";

describe("bumpHostname", () => {
  it("increments the trailing digit by one", () => {
    expect(bumpHostname("proxvm6.zone.example")).toBe("proxvm7.zone.example");
    expect(bumpHostname("proxvm6")).toBe("proxvm7");
    expect(bumpHostname("db4.corp.example.com")).toBe("db5.corp.example.com");
  });

  it("carries past 9 without inventing a cap (proxvm9 → proxvm10)", () => {
    expect(bumpHostname("proxvm9.zone.example")).toBe("proxvm10.zone.example");
    expect(bumpHostname("v99.example.org")).toBe("v100.example.org");
  });

  it("appends 2 when the label has no trailing digits", () => {
    expect(bumpHostname("app.example.com")).toBe("app2.example.com");
    expect(bumpHostname("proxvm.zone.example")).toBe("proxvm2.zone.example");
  });

  it("only looks at the first label's tail", () => {
    expect(bumpHostname("proxvm.srv2.example.org")).toBe("proxvm2.srv2.example.org");
  });
});

describe("nextRotatedHostname", () => {
  it("returns the first unused bump", () => {
    expect(nextRotatedHostname("proxvm6.zone.example", ["proxvm7.zone.example"])).toBe("proxvm8.zone.example");
  });

  it("skips the whole used set (canonical + aliases)", () => {
    const used = [
      "proxvm7.zone.example",
      "proxvm8.zone.example",
      "proxvm10.zone.example",
    ];
    expect(nextRotatedHostname("proxvm6.zone.example", used)).toBe("proxvm9.zone.example");
  });

  it("gives up after maxAttempts instead of looping forever", () => {
    expect(nextRotatedHostname("proxvm99.zone.example", [], 2)).toBe("proxvm100.zone.example");
  });

  it("normalizes case/scheme garbage in the used set", () => {
    const used = new Set(["HTTPS://ProxVM7.zone.example/"]);
    expect(nextRotatedHostname("proxvm6.zone.example", used)).toBe("proxvm8.zone.example");
  });
});

describe("qualifyName", () => {
  it("expands bare labels and passes FQDNs through", () => {
    expect(qualifyName("proxvm7", "zone.example")).toBe("proxvm7.zone.example");
    expect(qualifyName("proxvm7.zone.example", "zone.example")).toBe("proxvm7.zone.example");
    expect(qualifyName("@", "zone.example")).toBe("zone.example");
    expect(qualifyName("HTTPS://ProxVM7.zone.example/", "zone.example")).toBe("proxvm7.zone.example");
  });
});
