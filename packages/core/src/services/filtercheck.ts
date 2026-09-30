import type { SettingsService } from "./settings.js";

/**
 * School content-filter monitoring (Securly).
 *
 * The Securly extension broker endpoint evaluates a hostname against a
 * user's school policy server-side and returns a plain-text verdict, so it
 * works as a block oracle from anywhere on the internet — no probe device
 * inside the filtered network needed. Verified live: same request with
 * host=proxvm2 returned `DENY:999:67109120:...` and host=www.google.com
 * returned `SS:999:CC:...`.
 *
 * Scope discipline: this is an admin alert only, always evaluated for the
 * current canonical domain. Unknown/timeout responses never report "clean"
 * and never trigger anything — they report unknown.
 */

export type FilterStatus = "blocked" | "clean" | "unknown" | "unconfigured";

export interface FilterCheckResult {
  status: FilterStatus;
  hostname: string | null;
  verdict: string | null;
  ruleId: string | null;
  detail: string;
}

export interface SecurlyConfig {
  useremail: string | null;
}

export async function getSecurlyConfig(
  settings: Pick<SettingsService, "get">,
): Promise<SecurlyConfig> {
  const env = (process.env.PROXVM_SECURILY_USEREMAIL ?? "").trim();
  if (env) return { useremail: env };
  const stored = await settings.get("securly.useremail");
  const value = (stored?.value ?? "").trim();
  return { useremail: value ? value : null };
}

export function securlyBrokerUrl(hostname: string, useremail: string): string {
  const params = new URLSearchParams({
    useremail,
    reason: "crextn",
    host: hostname,
    url: Buffer.from(`https://${hostname}`, "utf8").toString("base64"),
    msg: "",
    ver: "2.97.13",
    cu: "https://useast-www.securly.com/crextn",
    uf: "1",
    cf: "1",
  });
  return `https://useast-www.securly.com/crextn/broker?${params.toString()}`;
}

/** Parse a broker verdict body. Anything not starting with DENY is not a block. */
export function parseSecurlyVerdict(body: string): { status: "blocked" | "clean"; ruleId: string | null } {
  const verdict = body.trim();
  if (verdict.startsWith("DENY")) {
    const parts = verdict.split(":");
    return { status: "blocked", ruleId: parts.length >= 3 ? (parts[2] as string) : null };
  }
  return { status: "clean", ruleId: null };
}

export async function checkSecurlyBlock(
  hostname: string,
  useremail: string,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<FilterCheckResult> {
  const timeoutMs = opts?.timeoutMs ?? 10000;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(securlyBrokerUrl(hostname, useremail), { signal: controller.signal });
    const body = await res.text();
    if (!res.ok || !body.trim()) {
      return { status: "unknown", hostname, verdict: null, ruleId: null, detail: `broker HTTP ${res.status}` };
    }
    const parsed = parseSecurlyVerdict(body);
    if (parsed.status === "blocked") {
      return {
        status: "blocked",
        hostname,
        verdict: body.trim().slice(0, 120),
        ruleId: parsed.ruleId,
        detail: `Securly reports this hostname blocked${parsed.ruleId ? ` (rule ${parsed.ruleId})` : ""}`,
      };
    }
    return { status: "clean", hostname, verdict: body.trim().slice(0, 120), ruleId: null, detail: "No DENY verdict" };
  } catch (err) {
    return {
      status: "unknown",
      hostname,
      verdict: null,
      ruleId: null,
      detail: err instanceof Error ? err.message.slice(0, 120) : "check failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
