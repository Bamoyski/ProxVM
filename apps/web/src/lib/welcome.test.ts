import { describe, expect, it } from "vitest";
import { shouldShowWelcome } from "./welcome.js";

describe("shouldShowWelcome", () => {
  // Positive: the one settled, normal state where the intro shows.
  it("shows once identity and setup status are settled in normal mode", () => {
    expect(shouldShowWelcome({ isLoading: false, setupMode: false })).toBe(true);
  });

  // Negative states: never cover up a controlling flow.
  it("does not show while the session bootstrap is pending", () => {
    expect(shouldShowWelcome({ isLoading: true, setupMode: false })).toBe(false);
  });

  it("does not show in first-run setup mode", () => {
    expect(shouldShowWelcome({ isLoading: false, setupMode: true })).toBe(false);
  });

  it("does not show before /setup/status has answered", () => {
    expect(shouldShowWelcome({ isLoading: false, setupMode: null })).toBe(false);
  });

  it("does not show when a restart is required after setup", () => {
    expect(
      shouldShowWelcome({ isLoading: false, setupMode: false, restartRequired: true }),
    ).toBe(false);
  });

  // Boundary: loading false but setup still unknown must stay hidden.
  it("stays hidden until BOTH inputs settled (boundary)", () => {
    expect(shouldShowWelcome({ isLoading: false, setupMode: null, restartRequired: false })).toBe(false);
  });
});
