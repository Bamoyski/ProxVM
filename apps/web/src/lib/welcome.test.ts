import { describe, expect, it } from "vitest";
import { nextIntroPhase, resolveIntroVariant, shouldShowWelcome } from "./welcome.js";

describe("shouldShowWelcome", () => {
  // Positive: the one settled, normal state where the intro shows.
  it("shows once identity and setup status are settled in normal mode", () => {
    expect(shouldShowWelcome({ isLoading: false, setupMode: false, introVariant: "school" })).toBe(true);
  });

  // Default: the standard build has no splash at all.
  it("does not show when the intro variant is none", () => {
    expect(shouldShowWelcome({ isLoading: false, setupMode: false, introVariant: "none" })).toBe(false);
  });

  it("does not show when the variant has not been answered yet", () => {
    expect(shouldShowWelcome({ isLoading: false, setupMode: false })).toBe(false);
  });

  // Negative states: never cover up a controlling flow.
  it("does not show while the session bootstrap is pending", () => {
    expect(shouldShowWelcome({ isLoading: true, setupMode: false, introVariant: "school" })).toBe(false);
  });

  it("does not show in first-run setup mode", () => {
    expect(shouldShowWelcome({ isLoading: false, setupMode: true, introVariant: "school" })).toBe(false);
  });

  it("does not show before /setup/status has answered", () => {
    expect(shouldShowWelcome({ isLoading: false, setupMode: null, introVariant: "school" })).toBe(false);
  });

  it("does not show when a restart is required after setup", () => {
    expect(
      shouldShowWelcome({ isLoading: false, setupMode: false, restartRequired: true, introVariant: "school" }),
    ).toBe(false);
  });

  // Boundary: loading false but setup still unknown must stay hidden.
  it("stays hidden until BOTH inputs settled (boundary)", () => {
    expect(
      shouldShowWelcome({ isLoading: false, setupMode: null, restartRequired: false, introVariant: "school" }),
    ).toBe(false);
  });
});

describe("resolveIntroVariant", () => {
  // Positive: only the exact configured value selects the school splash.
  it("keeps an exact school value", () => {
    expect(resolveIntroVariant("school")).toBe("school");
    expect(resolveIntroVariant("none")).toBe("none");
  });

  // Negative: everything else must degrade to "no intro", never a guess.
  it("falls back to none for absent or malformed values", () => {
    for (const raw of [undefined, null, "", "School", "school ", "school\n", "standard", 42, true, {}, ["school"]]) {
      expect(resolveIntroVariant(raw)).toBe("none");
    }
  });
});

describe("nextIntroPhase", () => {
  const settled = { isLoading: false, setupMode: false, introVariant: "school" as const };

  // Positive: the pending phase becomes "shown" exactly once, when the gate
  // first reports the settled, normal state.
  it("shows when pending and the gate is satisfied", () => {
    expect(nextIntroPhase("pending", settled)).toBe("shown");
  });

  // Negative: pending without the gate stays pending (no premature show).
  it("stays pending while the gate is not satisfied", () => {
    expect(nextIntroPhase("pending", { isLoading: true, setupMode: false, introVariant: "school" })).toBe("pending");
    expect(nextIntroPhase("pending", { isLoading: false, setupMode: null, introVariant: "school" })).toBe("pending");
    expect(nextIntroPhase("pending", { isLoading: false, setupMode: true, introVariant: "school" })).toBe("pending");
  });

  // The default build never leaves pending, so the intro never renders.
  it("stays pending when the intro variant is none", () => {
    expect(nextIntroPhase("pending", { isLoading: false, setupMode: false, introVariant: "none" })).toBe("pending");
    expect(nextIntroPhase("pending", { isLoading: false, setupMode: false })).toBe("pending");
  });

  // Critical regression: "shown" stays "shown" regardless of the gate. This is
  // what guarantees once-per-app-start semantics — hiding must never re-trigger
  // the show effect when the (still true) gate is re-evaluated.
  it("stays shown regardless of the gate (no re-show after hide)", () => {
    expect(nextIntroPhase("shown", settled)).toBe("shown");
    expect(nextIntroPhase("shown", { isLoading: true, setupMode: false, introVariant: "school" })).toBe("shown");
  });

  // Boundary: done is terminal.
  it("stays done forever", () => {
    expect(nextIntroPhase("done", settled)).toBe("done");
    expect(nextIntroPhase("done", { isLoading: false, setupMode: null, introVariant: "school" })).toBe("done");
  });
});
