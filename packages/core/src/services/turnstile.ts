// ---------------------------------------------------------------------------
// Self-serve registration configuration + Cloudflare Turnstile verification.
//
// Mode dial (settings key "selfserve.mode", category "system"):
//   closed   — POST /auth/register refuses outright (403)
//   approval — today's behavior: request lands in the pending queue
//   auto     — register creates the account immediately with the GUEST role
//
// Turnstile (keys "selfserve.turnstile_site_key" / ".turnstile_secret",
// encrypted secret, env-first like every other integration:
// PROXVM_TURNSTILE_SITE_KEY / PROXVM_TURNSTILE_SECRET):
//   - When a secret is configured, EVERY registration must present a token
//     minted by the widget (site key is public; the secret never leaves the
//     server outside the siteverify call).
//   - auto WITHOUT a configured secret downgrades to approval: silently
//     auto-approving strangers through an unbotted public form defeats the
//     point of the gate, so the safe path wins automatically.
//
// getSelfServeConfig never throws; a malformed stored mode falls back to
// "approval" so a typo'd setting cannot brick either registration path.
// ---------------------------------------------------------------------------
import type { SettingsService } from "./settings.js";

export type SelfServeMode = "closed" | "approval" | "auto";

export interface SelfServeConfig {
  storedMode: SelfServeMode;
  /** mode actually in force: auto without Turnstile degrades to approval. */
  mode: SelfServeMode;
  turnstileSiteKey: string | null;
  turnstileSecret: string | null;
}

const MODES: ReadonlySet<string> = new Set(["closed", "approval", "auto"]);

function modeFromStored(raw: string | null): SelfServeMode {
  return raw && MODES.has(raw) ? (raw as SelfServeMode) : "approval";
}

function envOr(el: { value: string | null } | null, envKey: string): string | null {
  const fromEnv = (process.env[envKey] ?? "").trim();
  if (fromEnv) return fromEnv;
  return el?.value?.trim() || null;
}

export async function getSelfServeConfig(settings: SettingsService): Promise<SelfServeConfig> {
  const [mode, siteKey, secret] = await Promise.all([
    settings.getPlain("selfserve.mode"),
    settings.get("selfserve.turnstile_site_key"),
    settings.get("selfserve.turnstile_secret"),
  ]);
  const storedMode = modeFromStored(mode);
  const resolvedSecret = envOr(secret, "PROXVM_TURNSTILE_SECRET");
  const config: SelfServeConfig = {
    storedMode,
    mode: storedMode,
    turnstileSiteKey: envOr(siteKey, "PROXVM_TURNSTILE_SITE_KEY"),
    turnstileSecret: resolvedSecret,
  };
  if (storedMode === "auto" && !resolvedSecret) {
    config.mode = "approval";
  }
  return config;
}

interface TurnstileVerifyResponse {
  success: boolean;
  "error-codes"?: string[];
  /** Action the widget was rendered with (data-action). */
  action?: string;
  /** Hostname the challenge was solved on, no port. */
  hostname?: string;
}

export interface TurnstileExpectations {
  /** Reject tokens minted for a different surface (e.g. login vs signup). */
  action?: string;
  /** Reject tokens solved on a different frontend hostname. */
  hostname?: string | null;
}

/**
 * Verify a Turnstile token against Cloudflare's siteverify endpoint.
 * Returns false on ANY failure (bad token, expired, network error) —
 * registration must fail closed. Fixed endpoint: whatever the caller passes
 * as secret goes only here, and it is never logged.
 *
 * When `expect` is supplied, siteverify's echoed action/hostname must match.
 * Cloudflare binds both to the solved token, so this stops a token solved on
 * another site (or another widget surface on the same site) from being
 * replayed against the signup endpoint.
 */
export async function verifyTurnstileToken(
  secret: string,
  token: string,
  remoteIp?: string | null,
  expect: TurnstileExpectations = {},
): Promise<boolean> {
  // Empty or oversized input cannot be a real token; refuse before the
  // outbound call so junk bodies stay cheap.
  if (!secret || typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return false;
  }
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    const parsed = (await response.json()) as TurnstileVerifyResponse;
    if (parsed.success !== true) return false;
    if (expect.action !== undefined && parsed.action !== expect.action) return false;
    const expectedHostname = (expect.hostname ?? "").trim().toLowerCase();
    if (expectedHostname && (parsed.hostname ?? "").trim().toLowerCase() !== expectedHostname) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
