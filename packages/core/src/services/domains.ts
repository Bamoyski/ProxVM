import { AppError } from "../util/errors.js";
import type { SettingsService } from "./settings.js";

export const CANONICAL_KEY = "app.canonical_domain";
export const ALIASES_KEY = "app.domain_aliases";

/** Lowercase bare hostname: strips scheme, path, port, trailing dot. */
export function normalizeHostname(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split("/")[0] ?? "";
  value = value.split("@").pop() ?? "";
  const bracketed = value.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) value = bracketed[1] as string;
  else value = value.split(":")[0] ?? "";
  if (value.endsWith(".")) value = value.slice(0, -1);
  return value;
}

export function assertValidHostname(host: string): void {
  if (!/^(?=.{1,253}$)[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes(".")) {
    throw AppError.validation("Invalid domain name (use a bare hostname like app.example.com)");
  }
}

export interface DomainConfig {
  canonical: string | null;
  aliases: string[];
}

/**
 * Decide whether an incoming request should 301 to the canonical domain.
 * Only explicitly-listed old domains redirect; unknown hosts (IPs,
 * localhost, future DNS) always serve normally. API traffic is never
 * redirected (clients don't follow POST redirects safely) except share-link
 * redemption, which is a plain GET with no body.
 */
export function resolveDomainRedirect(opts: {
  host: string | undefined;
  url: string;
  method: string;
  canonical: string | null;
  aliases: string[];
}): string | null {
  if (!opts.canonical) return null;
  const host = normalizeHostname(opts.host ?? "");
  if (!host || host === opts.canonical) return null;
  if (!opts.aliases.includes(host)) return null;
  if (opts.method !== "GET") return null;
  const path = opts.url.split("?")[0] ?? "/";
  if (path.startsWith("/api/") && !path.startsWith("/api/s/")) return null;
  const query = opts.url.includes("?") ? opts.url.slice(opts.url.indexOf("?")) : "";
  return `https://${opts.canonical}${path}${query}`;
}

export async function getDomainConfig(settings: Pick<SettingsService, "get">): Promise<
  DomainConfig & { cloudflareZoneId: string | null }
> {
  const [canonical, aliases, zone] = await Promise.all([
    settings.get(CANONICAL_KEY),
    settings.get(ALIASES_KEY),
    settings.get("cloudflare.zone_id"),
  ]);
  let parsed: string[] = [];
  try {
    const raw = aliases ? JSON.parse(aliases.value) : [];
    if (Array.isArray(raw)) parsed = raw.filter((h): h is string => typeof h === "string").map(normalizeHostname).filter(Boolean);
  } catch {
    parsed = [];
  }
  return {
    canonical: canonical ? normalizeHostname(canonical.value) || null : null,
    aliases: [...new Set(parsed)],
    cloudflareZoneId: zone?.value ?? null,
  };
}

/**
 * Point the canonical domain at a new host. The previous canonical host is
 * automatically kept as a redirect alias so old URLs keep working — that is
 * exactly why old DNS records must NOT be deleted during a switch.
 */
export async function setCanonicalDomain(
  settings: Pick<SettingsService, "get" | "set">,
  rawHost: string,
): Promise<DomainConfig> {
  const host = normalizeHostname(rawHost);
  assertValidHostname(host);
  const current = await getDomainConfig(settings);
  const aliases = current.aliases.filter((a) => a !== host);
  if (current.canonical && current.canonical !== host) aliases.push(current.canonical);
  await settings.set(CANONICAL_KEY, host, { category: "system" });
  await settings.set(ALIASES_KEY, JSON.stringify([...new Set(aliases)]), { category: "system" });
  return { canonical: host, aliases: [...new Set(aliases)] };
}

export async function removeDomainAlias(
  settings: Pick<SettingsService, "get" | "set">,
  rawHost: string,
): Promise<DomainConfig> {
  const host = normalizeHostname(rawHost);
  const current = await getDomainConfig(settings);
  const aliases = current.aliases.filter((a) => a !== host);
  await settings.set(ALIASES_KEY, JSON.stringify(aliases), { category: "system" });
  return { canonical: current.canonical, aliases };
}
