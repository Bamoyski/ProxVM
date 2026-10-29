/**
 * Welcome-page gate: the brief scholarly intro page is shown once per app
 * start, only when the app is in normal "ready" state — never during first-run
 * setup, while the session bootstrap is still in flight, or when a restart is
 * required — and only when the instance's intro variant is "school". Pure
 * logic so the App.tsx conditions stay testable.
 */

/**
 * Intro splash variants (Settings → Appearance). Presentation only.
 *   "none"   → no intro at all (default)
 *   "school" → the Wrenfield Academy landing page
 */
export type IntroVariant = "none" | "school";

/**
 * Normalise the variant delivered by the public /setup/status boot call.
 * Exact-match allowlist: anything unexpected (absent, null, junk) means no
 * intro, so a bad value can never show the wrong surface.
 */
export function resolveIntroVariant(raw: unknown): IntroVariant {
  return raw === "school" ? "school" : "none";
}

export type WelcomeGateInput = {
  /** True while the /me session bootstrap is pending. */
  isLoading: boolean;
  /** null = /setup/status not answered yet; false = normal operation. */
  setupMode: boolean | null;
  /** True when setup finished and needs an API restart. */
  restartRequired?: boolean;
  /** Intro variant from /setup/status; absent/unknown means no intro. */
  introVariant?: IntroVariant;
};

/** Whether the intro page should be displayed right now. */
export function shouldShowWelcome(gate: WelcomeGateInput): boolean {
  if (gate.isLoading) return false;
  if (gate.setupMode !== false) return false;
  if (gate.restartRequired) return false;
  if (resolveIntroVariant(gate.introVariant) !== "school") return false;
  return true;
}

/** How long the intro page stays up before the app continues. */
export const WELCOME_DURATION_MS = 2500;

/**
 * One-pass intro phase. `pending` waits for the settled-normal gate, then
 * becomes `shown` exactly once — `done` is terminal, so hiding the intro can
 * never re-trigger it (verified in the browser: a boolean flag re-showed the
 * intro forever because the settled gate stays true after hide).
 */
export type IntroPhase = "pending" | "shown" | "done";

/** Pure transition for the intro state machine. */
export function nextIntroPhase(phase: IntroPhase, gate: WelcomeGateInput): IntroPhase {
  if (phase === "done") return "done";
  if (phase === "pending") return shouldShowWelcome(gate) ? "shown" : "pending";
  return "shown";
}
