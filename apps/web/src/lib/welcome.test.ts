import { describe, expect, it } from "vitest";
import { nextIntroPhase, shouldShowWelcome } from "./welcome.js";

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

describe("nextIntroPhase", () => {
  const settled = { isLoading: false, setupMode: false };

  // Positive: the pending phase becomes "shown" exactly once, when the gate
  // first reports the settled, normal state.
  it("shows when pending and the gate is satisfied", () => {
    expect(nextIntroPhase("pending", settled)).toBe("shown");
  });

  // Negative: pending without the gate stays pending (no premature show).
  it("stays pending while the gate is not satisfied", () => {
    expect(nextIntroPhase("pending", { isLoading: true, setupMode: false })).toBe("pending");
    expect(nextIntroPhase("pending", { isLoading: false, setupMode: null })).toBe("pending");
    expect(nextIntroPhase("pending", { isLoading: false, setupMode: true })).toBe("pending");
  });

  // Critical regression: "shown" stays "shown" regardless of the gate. This is
  // what guarantees once-per-app-start semantics — hiding must never re-trigger
  // the show effect when the (still true) gate is re-evaluated.
  it("stays shown regardless of the gate (no re-show after hide)", () => {
    expect(nextIntroPhase("shown", settled)).toBe("shown");
    expect(nextIntroPhase("shown", { isLoading: true, setupMode: false })).toBe("shown");
  });

  // Boundary: done is terminal.
  it("stays done forever", () => {
    expect(nextIntroPhase("done", settled)).toBe("done");
    expect(nextIntroPhase("done", { isLoading: false, setupMode: null })).toBe("done");
  });
});
