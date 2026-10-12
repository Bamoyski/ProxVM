// ---------------------------------------------------------------------------
// Domains: canonical-host redirects, CORS origins, Cloudflare + DNS checks.
// - Canonical + aliases are the only redirect sources; unknown hosts (IPs,
//   localhost) always serve normally, and non-GET/API traffic never 301s
//   (clients do not follow POST redirects safely; share GETs are exempt).
// - Switching canonical keeps the old host as an alias so old URLs survive;
//   old DNS records must NOT be deleted during a switch.
// - verifyDomainReachability gates on public DNS (IP literals and private
//   ranges rejected: admin-gated endpoint must not become a scan oracle);
//   the HTTPS probe is advisory because TLS lives at the proxy layer.
// - Hostname parsing/validation avoids regex backtracking (linear scans) as
//   input arrives via the raw Host header.
// ---------------------------------------------------------------------------
import { promises as dns } from "node:dns";
import net from "node:net";
import { AppError } from "../util/errors.js";
import type { SettingsService } from "./settings.js";
import { fetchWithSsrfGuard } from "../util/ssrf.js";
import { stripTrailingSlashes } from "../util/misc.js";

/** True for loopback, unspecified, link-local, and RFC 1918/unique-local ranges. */
export function isNonPublicIp(ip: string): boolean {
  if (!net.isIP(ip)) return false;
  if (net.isIPv4(ip)) {
    const n = ip.split(".").reduce((acc, p) => acc * 256 + Number(p), 0) >>> 0;
    const inRange = (base: string, prefix: number): boolean => {
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      const b = base.split(".").reduce((acc, p) => acc * 256 + Number(p), 0) >>> 0;
      return ((n & mask) >>> 0) === ((b & mask) >>> 0);
    };
    return (
      inRange("127.0.0.0", 8) ||
      inRange("0.0.0.0", 8) ||
      inRange("10.0.0.0", 8) ||
      inRange("172.16.0.0", 12) ||
      inRange("192.168.0.0", 16) ||
      inRange("169.254.0.0", 16) ||
      inRange("192.0.2.0", 24) ||
      inRange("198.51.100.0", 24) ||
      inRange("203.0.113.0", 24)
    );
  }
  // IPv6: loopback, unspecified, link-local, unique-local.
  const l = ip.toLowerCase();
  return (
    l === "::1" ||
    l === "::" ||
    l.startsWith("fe80:") ||
    l.startsWith("fe80::") ||
    l.startsWith("fc") ||
    l.startsWith("fd")
  );
}

export const CANONICAL_KEY = "app.canonical_domain";
export const ALIASES_KEY = "app.domain_aliases";

/**
 * Strip a leading URI scheme ("https://") without regex: the old
 * `/^[a-z][a-z0-9+.-]*:\/\//` pattern has nested overlapping quantifiers
 * (polynomial backtracking on hostile input, which reaches here via the
 * raw request Host header). Linear scan, identical accept set.
 */
function stripUrlScheme(value: string): string {
  const idx = value.indexOf("://");
  if (idx <= 0) return value;
  const first = value.charCodeAt(0);
  if (first < 97 || first > 122) return value;
  for (let i = 1; i < idx; i++) {
    const c = value.charCodeAt(i);
    const ok =
      (c >= 97 && c <= 122) || // a-z
      (c >= 48 && c <= 57) || // 0-9
      c === 43 || // +
      c === 45 || // -
      c === 46; // .
    if (!ok) return value;
  }
  return value.slice(idx + 3);
}

/** Lowercase bare hostname: strips scheme, path, port, trailing dot. */
export function normalizeHostname(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = stripUrlScheme(value);
  value = value.split("/")[0] ?? "";
  value = value.split("@").pop() ?? "";
  const bracketed = value.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) value = bracketed[1] as string;
  else value = value.split(":")[0] ?? "";
  if (value.endsWith(".")) value = value.slice(0, -1);
  return value;
}

function isHostnameChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
}

function isValidHostnameLabel(label: string): boolean {
  if (label.length < 1 || label.length > 63) return false;
  if (!isHostnameChar(label.charCodeAt(0)) || !isHostnameChar(label.charCodeAt(label.length - 1))) return false;
  for (let i = 1; i < label.length - 1; i++) {
    const c = label.charCodeAt(i);
    if (!isHostnameChar(c) && c !== 45) return false;
  }
  return true;
}

/** Throws unless the host is a dotted bare hostname (labels 1-63 chars). */
export function assertValidHostname(host: string): void {
  // Manual per-label validation: the old
  // `/^(?=.{1,253}$)[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/` nests overlapping
  // quantifiers (polynomial backtracking). Same accept set: 1-253 chars,
  // dot-separated labels of 1-63 chars, alphanumeric ends, interior
  // alphanumerics/hyphens, at least one dot.
  let valid = host.length >= 1 && host.length <= 253 && host.includes(".");
  if (valid) {
    const labels = host.split(".");
    for (const label of labels) {
      if (!isValidHostnameLabel(label)) {
        valid = false;
        break;
      }
    }
  }
  if (!valid) {
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

/** Canonical + deduped aliases + Cloudflare zone for request handling. */
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

/**
 * Exact CORS origins the API accepts. The configured env origin is always
 * honored (backward compatible with LAN/IP setups); on top of that, the
 * canonical domain and every redirect alias are allowed as https origins so
 * a domain switch keeps working without an API restart or env edit. Plain
 * http is deliberately NOT added for public hostnames — TLS termination is
 * the proxy's job and credentialed CORS over plaintext would downgrade it.
 */
export function getAllowedWebOrigins(
  envOrigin: string | undefined,
  config: DomainConfig,
): string[] {
  const out = new Set<string>();
  const cleanEnv = stripTrailingSlashes((envOrigin ?? "").trim());
  if (cleanEnv) out.add(cleanEnv);
  const hosts = [config.canonical, ...config.aliases].filter((h): h is string => !!h);
  for (const host of hosts) out.add(`https://${host}`);
  return [...out];
}

export interface DomainVerification {
  dnsOk: boolean;
  httpsOk: boolean;
  detail: string;
}

/**
 * Pre-flip reachability check for a candidate domain. DNS resolution is the
 * hard gate (flipping canonical to an unresolvable name bounces every old
 * URL into the void); the HTTPS probe is advisory — a grey-cloud record or
 * a still-provisioning certificate is a warning, not a veto, because TLS
 * termination belongs to the proxy layer.
 */
export async function verifyDomainReachability(
  fqdn: string,
  opts?: { timeoutMs?: number },
): Promise<DomainVerification> {
  const timeoutMs = opts?.timeoutMs ?? 8000;
  // Domain verification must never probe infrastructure addresses: reject IP
  // literals and resolved private/loopback/link-local ranges up front. This
  // endpoint is admin-gated, but a compromised admin session must not become
  // an internal port-scan oracle.
  if (net.isIP(fqdn)) {
    return { dnsOk: false, httpsOk: false, detail: "dns: IP literals are not valid domain names" };
  }
  let dnsOk = false;
  let dnsDetail = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const addrs = await dns.resolve(fqdn);
      const publicAddrs = addrs.filter((a) => !isNonPublicIp(a));
      if (publicAddrs.length > 0) {
        dnsOk = true;
        dnsDetail = `${publicAddrs.length} public address(es) resolve`;
        break;
      }
      dnsDetail = addrs.length > 0 ? "only non-public addresses resolve" : "no addresses returned";
      break;
    } catch (err) {
      dnsDetail = err instanceof Error ? err.message.split(",")[0] ?? "lookup failed" : "lookup failed";
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
  }
  let httpsOk = false;
  let httpsDetail = "not probed";
  if (dnsOk) {
    // Retried: right after an ingress write, cloudflared can take seconds to
    // serve the new hostname. A single-shot probe would report a false 404.
    for (let attempt = 0; attempt < 3 && !httpsOk; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 4000));
      try {
        const res = await fetchWithSsrfGuard(`https://${fqdn}/api/health/live`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        httpsOk = res.ok;
        httpsDetail = httpsOk ? "login API reachable over TLS" : `HTTP ${res.status} from health endpoint`;
      } catch (err) {
        httpsDetail = err instanceof Error ? err.message.slice(0, 120) : "probe failed";
      }
    }
  }
  return { dnsOk, httpsOk, detail: `dns: ${dnsDetail}; https: ${httpsDetail}` };
}

export interface CloudflareConfig {
  apiToken: string | null;
  zoneId: string | null;
  accountId: string | null;
  tunnelId: string | null;
}

/**
 * Cloudflare wiring, environment-first. Operators who bake the values into
 * the server environment (or local .env, which is gitignored) never touch
 * the UI settings; the UI-saved values remain as fallback for everyone else.
 * Nothing here is ever logged — the token only travels as an Authorization
 * header inside the Cloudflare client.
 */
export async function getCloudflareConfig(
  settings: Pick<SettingsService, "get">,
): Promise<CloudflareConfig> {
  const fromEnv = (key: string): string | null => {
    const value = (process.env[key] ?? "").trim();
    return value ? value : null;
  };
  const [token, zone, account, tunnel] = await Promise.all([
    settings.get("cloudflare.api_token"),
    settings.get("cloudflare.zone_id"),
    settings.get("cloudflare.account_id"),
    settings.get("cloudflare.tunnel_id"),
  ]);
  return {
    apiToken: fromEnv("PROXVM_CLOUDFLARE_API_TOKEN") ?? token?.value ?? null,
    zoneId: fromEnv("PROXVM_CLOUDFLARE_ZONE_ID") ?? zone?.value ?? null,
    accountId: fromEnv("PROXVM_CLOUDFLARE_ACCOUNT_ID") ?? account?.value ?? null,
    tunnelId: fromEnv("PROXVM_CLOUDFLARE_TUNNEL_ID") ?? tunnel?.value ?? null,
  };
}

/**
 * Park an old hostname as a redirect alias without touching canonical.
 * This is the "make the old URL forward to the new one" action for moves
 * that happened outside the Switch flow (which only accumulates aliases
 * when canonical actually changes).
 */
export async function addDomainAlias(
  settings: Pick<SettingsService, "get" | "set">,
  rawHost: string,
): Promise<DomainConfig> {
  const host = normalizeHostname(rawHost);
  assertValidHostname(host);
  const current = await getDomainConfig(settings);
  if (current.canonical && host === current.canonical) {
    throw AppError.validation(`${host} is already the current domain — nothing to redirect`);
  }
  if (current.aliases.includes(host)) return current;
  const aliases = [...current.aliases, host];
  await settings.set(ALIASES_KEY, JSON.stringify(aliases), { category: "system" });
  return { canonical: current.canonical, aliases };
}

/** Drops an alias; canonical is never touched by alias removal. */
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
