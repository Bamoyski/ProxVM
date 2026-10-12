import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "./errors.js";

/**
 * Centralized SSRF guard for server-initiated http(s) destinations
 * (setup connection tests, stored Proxmox/Guacamole URLs, health checks).
 *
 * Policy mirrors the webhook path in services/threats.ts: loopback,
 * unspecified, link-local and cloud-metadata hosts are refused outright
 * (in every textual form, plus DNS-rebinding to them), while private LAN
 * ranges are PERMITTED — homelab Proxmox/Guacamole/webhooks live on the LAN
 * by design, and these URLs are only ever settable by setup-token or
 * settings.manage holders, so the remaining trust is in the operator.
 */

function parseNumericParts(host: string): number[] | null {
  let v4 = host;
  const mapped = host.match(/^(?:::ffff:)(.+)$/i);
  if (mapped) {
    v4 = mapped[1]!;
    if (v4.includes(":")) {
      const groups = v4.split(":");
      if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) {
        const n = (parseInt(groups[0]!, 16) << 16) | parseInt(groups[1]!, 16);
        v4 = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
      } else {
        return [127, 0, 0, 1];
      }
    }
  }
  const parsePart = (part: string): number | null => {
    let p = part;
    let base = 10;
    if (/^0x[0-9a-f]+$/i.test(p)) {
      base = 16;
      p = p.slice(2);
    } else if (/^0[0-7]+$/.test(p) && p.length > 1) {
      base = 8;
      p = p.slice(1);
    } else if (!/^\d+$/.test(p)) {
      return null;
    }
    const n = parseInt(p, base);
    return Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff ? n : null;
  };
  const parts = v4.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const n = parsePart(part);
    if (n === null) return null;
    nums.push(n);
  }
  if (nums.length === 4) {
    if (nums.some((n) => n > 255)) return null;
    return nums;
  }
  if (nums.length === 1) {
    const n = nums[0]!;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  const head = nums.slice(0, -1);
  if (head.some((n) => n > 255)) return null;
  const tailBits = nums.length === 2 ? 24 : 16;
  const tail = nums[nums.length - 1]!;
  if (tail >= 2 ** tailBits) return null;
  const tailBytes: number[] = [];
  for (let s = tailBits - 8; s >= 0; s -= 8) tailBytes.push((tail >>> s) & 255);
  return [...head, ...tailBytes];
}

/** True when the hostname/address must never be dialed by the server. */
export function isBlockedServerDestination(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal")
  ) {
    return true;
  }
  const quadPrefix = host.match(/^(\d{1,3}(?:\.\d{1,3}){3})\./);
  if (quadPrefix) {
    const octets = quadPrefix[1]!.split(".").map(Number);
    if (octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      const [a, b] = octets;
      if (a === 127 || a === 0) return true;
      if (a === 169 && b === 254) return true;
    }
  }
  const numeric = parseNumericParts(host);
  if (numeric) {
    const [a, b] = numeric;
    if (a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (host.includes(":")) {
    const h = host.toLowerCase();
    if (h === "::1" || h === "::") return true;
    if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
    if (h.startsWith("::ffff:")) return true;
    return false;
  }
  return false;
}

/** Literal check first, then DNS: every resolved address must be safe. */
export async function assertSafeServerHost(hostname: string, what = "destination"): Promise<void> {
  if (isBlockedServerDestination(hostname)) {
    throw AppError.validation(`${what} must not target loopback, private, link-local, or cloud metadata endpoints`);
  }
  if (isIP(hostname)) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw AppError.validation(`${what} does not resolve`);
  }
  if (addresses.length === 0 || addresses.some((r) => isBlockedServerDestination(r.address))) {
    throw AppError.validation(`${what} resolves to a blocked address`);
  }
}

/** Validate a full http(s) URL: scheme + literal + DNS checks. */
export async function assertSafeServerUrl(raw: string, what = "URL"): Promise<string> {
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw AppError.validation(`${what} must be a valid http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw AppError.validation(`${what} must use http or https`);
  }
  await assertSafeServerHost(parsed.hostname, what);
  return url;
}

/**
 * Fetch that refuses to follow redirects into blocked networks. Returns the
 * final response; callers decide status handling. DNS is re-checked on every
 * redirect hop (rebinding-safe).
 */
export async function fetchWithSsrfGuard(
  url: string,
  init?: RequestInit,
  maxRedirects = 1,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(current);
    await assertSafeServerHost(parsed.hostname, "redirect target");
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status !== 301 && res.status !== 302 && res.status !== 307 && res.status !== 308) {
      return res;
    }
    const location = res.headers.get("location");
    if (!location) throw new Error("Redirect without Location");
    const next = new URL(location, current);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error("Redirect target refused");
    }
    current = next.toString();
  }
  throw new Error("Redirect limit exceeded");
}
