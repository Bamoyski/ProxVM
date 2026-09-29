import { promises as dns } from "node:dns";
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
  const cleanEnv = (envOrigin ?? "").trim().replace(/\/+$/, "");
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
  let dnsOk = false;
  let dnsDetail = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const addrs = await dns.resolve(fqdn);
      if (addrs.length > 0) {
        dnsOk = true;
        dnsDetail = `${addrs.length} address(es) resolve`;
        break;
      }
      dnsDetail = "no addresses returned";
    } catch (err) {
      dnsDetail = err instanceof Error ? err.message.split(",")[0] ?? "lookup failed" : "lookup failed";
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
  }
  let httpsOk = false;
  let httpsDetail = "not probed";
  if (dnsOk) {
    try {
      const res = await fetch(`https://${fqdn}/api/health/live`, { signal: AbortSignal.timeout(timeoutMs) });
      httpsOk = res.ok;
      httpsDetail = httpsOk ? "login API reachable over TLS" : `HTTP ${res.status} from health endpoint`;
    } catch (err) {
      httpsDetail = err instanceof Error ? err.message.slice(0, 120) : "probe failed";
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
