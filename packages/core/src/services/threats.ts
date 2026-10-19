// ---------------------------------------------------------------------------
// Threat detection: stateless, recomputed findings over recent audit rows.
// - No findings table: every rule is pure over (rows, now), so there is
//   nothing to dismiss, age out, or desync; same input always same output.
// - Summaries carry no VM names/ids, so results need no privacy-flag
//   filtering before display.
// - Webhook alerting dedupes on deterministic finding ids (last 200 kept);
//   the webhook URL is SSRF-guarded with resolve-and-pin + manual redirects.
// - findNewIpLogins is the one stateful rule: it queries history beyond the
//   window to spot first-seen (actor, ip) logins.
// - Shared egress addresses (trusted proxy hops — e.g. the Cloudflare Tunnel
//   box — from PROXVM_TRUST_PROXY): rows carrying one of them identify the
//   hop, never the client, because every tunneled user shows the same
//   address. Such rows count as ip-less here, so per-IP rules (spray,
//   compromised-login, recon scans) cannot fire on them while per-account
//   rules still see every event.
// ---------------------------------------------------------------------------
import { lookup as dnsLookup } from "node:dns/promises";
import type { Pool } from "pg";
import type { AuditRecord } from "@proxvm/shared";
import { AppError } from "../util/errors.js";
import type { SettingsService } from "./settings.js";
import type { AuditService } from "./audit.js";

/**
 * Point-in-time threat detection over the audit trail. Findings are
 * recomputed on every request from recent audit rows — there is no
 * persistent findings table, so there is nothing to dismiss, age out, or
 * desynchronize. Each rule is a pure function of (rows, now) for easy
 * unit testing; summaries deliberately carry no VM names/ids so results
 * need no privacy-flag filtering.
 */

export const THREAT_CATEGORIES = ["brute-force", "privilege", "secrets", "anomaly", "infra"] as const;
export type ThreatCategory = (typeof THREAT_CATEGORIES)[number];

export const THREAT_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type ThreatSeverity = (typeof THREAT_SEVERITIES)[number];

export interface ThreatFinding {
  id: string;
  category: ThreatCategory;
  severity: ThreatSeverity;
  title: string;
  summary: string;
  actorUsername: string | null;
  ip: string | null;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  events: string[];
}

export interface ThreatDetectOptions {
  /** Lookback window in days. Default 7, capped at 30 by the API route. */
  windowDays?: number;
  /**
   * Addresses (plain IPs or IPv4 CIDRs — the PROXVM_TRUST_PROXY list works
   * verbatim) that are shared proxy hops, not clients. Rows carrying one of
   * them are treated as ip-less: every user behind a single hop (Cloudflare
   * Tunnel egress, docker network) shows the same address, so per-IP
   * correlation on it is meaningless. Per-account rules still run.
   * Consumed by detectThreats and findNewIpLogins; detectOutOfBand ignores
   * it (no IP dimension).
   */
  sharedEgressIps?: string[];
}

const DAY_MS = 86400000;

function windowStart(rows: AuditRecord[], nowMs: number, days: number): AuditRecord[] {
  const since = nowMs - days * DAY_MS;
  return rows.filter((r) => r.createdAt.getTime() >= since && r.createdAt.getTime() <= nowMs);
}

function reasonOf(row: AuditRecord): string | null {
  const d = row.detail as Record<string, unknown> | null;
  return d && typeof d.reason === "string" ? d.reason : null;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "unknown";
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function span(rows: AuditRecord[]): { firstSeen: Date; lastSeen: Date } {
  let first = rows[0]!.createdAt;
  let last = rows[0]!.createdAt;
  for (const r of rows) {
    if (r.createdAt < first) first = r.createdAt;
    if (r.createdAt > last) last = r.createdAt;
  }
  return { firstSeen: first, lastSeen: last };
}

/** Strict dotted-quad IPv4 to unsigned int; null for anything else. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = ((n << 8) | octet) >>> 0;
  }
  return n;
}

/**
 * True when `ip` is one of the deployment's shared egress addresses.
 * Entries are plain hosts ("192.168.1.138") or CIDRs ("10.0.0.0/8",
 * "::1/128" as a host route); malformed entries simply never match.
 * WHY this exists: a shared hop address says nothing about WHICH client a
 * request came from (all tunneled users look identical), so per-IP rules
 * must not treat it as an attacker identity.
 */
export function isSharedEgressIp(ip: string, sharedEgressIps: readonly string[]): boolean {
  const value = ip.trim().toLowerCase();
  if (!value) return false;
  for (const raw of sharedEgressIps) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const slash = entry.indexOf("/");
    if (slash === -1) {
      if (value === entry) return true;
      continue;
    }
    const base = entry.slice(0, slash);
    const prefix = Number(entry.slice(slash + 1));
    if (!Number.isInteger(prefix) || prefix < 0) continue;
    const ipNum = ipv4ToInt(value);
    const baseNum = ipv4ToInt(base);
    if (ipNum === null || baseNum === null) {
      // Non-IPv4 entries can only ever match as a host route (e.g. ::1/128).
      if (prefix === 128 && value === base) return true;
      continue;
    }
    if (prefix > 32) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if (((ipNum & mask) >>> 0) === ((baseNum & mask) >>> 0)) return true;
  }
  return false;
}

/**
 * Demote shared-egress rows to ip-less before the rules run: the address
 * names the hop, never the client, so IP correlation on it would fire on
 * every user of the tunnel at once (spray, compromised-login, recon). The
 * events themselves survive for per-account rules.
 */
function stripSharedEgress(rows: AuditRecord[], sharedEgressIps?: readonly string[]): AuditRecord[] {
  if (!sharedEgressIps?.length) return rows;
  return rows.map((r) => (r.ip && isSharedEgressIp(r.ip, sharedEgressIps) ? { ...r, ip: null } : r));
}

  // -- Auth rules: brute-force, spray, compromised-login, lockout probes
/** N or more failed logins against one account inside 15 minutes. */
function bruteForceAccounts(rows: AuditRecord[]): ThreatFinding[] {
  const out: ThreatFinding[] = [];
  const failed = rows.filter((r) => r.event === "LOGIN_FAILED");
  for (const [username, attempts] of groupBy(failed, (r) => r.actorUsername ?? "unknown")) {
    if (username === "unknown" || attempts.length < 5) continue;
    // Sliding 15-minute window: any 5 attempts fitting inside it fires.
    const times = attempts.map((r) => r.createdAt.getTime()).sort((a, b) => a - b);
    let fires = false;
    for (let i = 0; i + 4 < times.length; i++) {
      if (times[i + 4]! - times[i]! <= 15 * 60000) {
        fires = true;
        break;
      }
    }
    if (!fires) continue;
    const ips = [...new Set(attempts.map((r) => r.ip).filter((ip): ip is string => !!ip))];
    const source = ips.length ? ` from ${ips.length === 1 ? ips[0] : `${ips.length} IPs`}` : "";
    out.push({
      id: `brute-force-account-${slug(username)}`,
      category: "brute-force",
      severity: "high",
      title: `Possible brute force on account "${username}"`,
      summary: `${attempts.length} failed logins in 15 minutes${source}. If this is not the account owner, lock the account${ips.length ? " and block the source" : ""}.`,
      actorUsername: username,
      ip: ips.length === 1 ? ips[0]! : null,
      count: attempts.length,
      ...span(attempts),
      events: ["LOGIN_FAILED"],
    });
  }
  return out;
}

/** One IP failing across several accounts inside 15 minutes: password spraying. */
function passwordSpray(rows: AuditRecord[]): ThreatFinding[] {
  const out: ThreatFinding[] = [];
  const failed = rows.filter((r) => r.event === "LOGIN_FAILED" && r.ip);
  for (const [ip, attempts] of groupBy(failed, (r) => r.ip as string)) {
    const users = new Set(attempts.map((r) => r.actorUsername ?? "unknown"));
    if (attempts.length < 5 || users.size < 3) continue;
    const times = attempts.map((r) => r.createdAt.getTime()).sort((a, b) => a - b);
    let fires = false;
    for (let i = 0; i + 4 < times.length; i++) {
      if (times[i + 4]! - times[i]! <= 15 * 60000) {
        fires = true;
        break;
      }
    }
    if (!fires) continue;
    out.push({
      id: `password-spray-${slug(ip)}`,
      category: "brute-force",
      severity: "high",
      title: `Possible password spray from ${ip}`,
      summary: `${attempts.length} failed logins across ${users.size} accounts in 15 minutes. Block the source IP if it is not a known NAT egress.`,
      actorUsername: null,
      ip,
      count: attempts.length,
      ...span(attempts),
      events: ["LOGIN_FAILED"],
    });
  }
  return out;
}

/**
 * A successful login from an IP that was spraying failures nearby: the one
 * pattern that means "they might be in". Correlates LOGIN rows against IPs
 * with 5+ failures inside any 15-minute window.
 */
function compromisedLogin(rows: AuditRecord[]): ThreatFinding[] {
  const out: ThreatFinding[] = [];
  const failed = rows.filter((r) => r.event === "LOGIN_FAILED" && r.ip);
  const hostile = new Set<string>();
  for (const [ip, attempts] of groupBy(failed, (r) => r.ip as string)) {
    if (attempts.length < 5) continue;
    const times = attempts.map((r) => r.createdAt.getTime()).sort((a, b) => a - b);
    for (let i = 0; i + 4 < times.length; i++) {
      if (times[i + 4]! - times[i]! <= 15 * 60000) {
        hostile.add(ip);
        break;
      }
    }
  }
  if (!hostile.size) return out;
  const logins = rows.filter((r) => r.event === "LOGIN" && r.ip && hostile.has(r.ip));
  for (const [key, items] of groupBy(logins, (r) => `${r.actorUsername ?? "unknown"}@${r.ip}`)) {
    const [username, ip] = key.split("@") as [string, string];
    if (username === "unknown") continue;
    out.push({
      id: `compromised-login-${slug(username)}-${slug(ip)}`,
      category: "brute-force",
      severity: "critical",
      title: `Successful login for "${username}" from attacking IP ${ip}`,
      summary: `${items.length} successful login(s) from an IP with a recent failure burst. Treat as a possible compromise: confirm with the user, rotate their credentials, and review their sessions.`,
      actorUsername: username,
      ip,
      count: items.length,
      ...span(items),
      events: ["LOGIN", "LOGIN_FAILED"],
    });
  }
  return out;
}

/** Lockouts and disabled-account attempts: someone is working accounts that cannot log in. */
function lockedAccountProbes(rows: AuditRecord[]): ThreatFinding[] {
  const out: ThreatFinding[] = [];
  for (const reason of ["account-locked", "account-disabled"]) {
    const hits = rows.filter((r) => r.event === "LOGIN_FAILED" && reasonOf(r) === reason);
    for (const [username, attempts] of groupBy(hits, (r) => r.actorUsername ?? "unknown")) {
      if (username === "unknown") continue;
      out.push({
        id: `locked-probe-${slug(reason)}-${slug(username)}`,
        category: "brute-force",
        severity: "medium",
        title:
          reason === "account-locked"
            ? `Login attempts against locked account "${username}"`
            : `Login attempts against disabled account "${username}"`,
        summary: `${attempts.length} attempt(s) against an account that cannot authenticate. Either the owner needs help, or an attacker has not noticed the lock.`,
        actorUsername: username,
        ip: attempts.length === 1 ? (attempts[0]!.ip ?? null) : null,
        count: attempts.length,
        ...span(attempts),
        events: ["LOGIN_FAILED"],
      });
    }
  }
  return out;
}

const PRIVILEGE_EVENTS = new Set([
  "ROLE_ASSIGNED",
  "GROUP_ROLE_ASSIGNED",
  "PERMISSION_CHANGED",
  "USER_CREATED",
  "TEMPORARY_ACCESS_GRANTED",
]);

function isPrivilegeGrant(row: AuditRecord): boolean {
  if (!PRIVILEGE_EVENTS.has(row.event)) return false;
  if (row.event === "USER_CREATED") {
    const d = row.detail as Record<string, unknown> | null;
    return d?.role === "ADMIN" || d?.role === "OPERATOR";
  }
  return true;
}

/** New or elevated grants: worth a human glance, especially off-hours. */
function privilegeGrants(rows: AuditRecord[]): ThreatFinding[] {
  const out: ThreatFinding[] = [];
  const grants = rows.filter(isPrivilegeGrant);
  for (const [actor, items] of groupBy(grants, (r) => r.actorUsername ?? "system")) {
    const offHours = items.filter((r) => {
      const h = r.createdAt.getUTCHours();
      return h >= 0 && h < 5;
    });
    out.push({
      id: `privilege-grants-${slug(actor)}`,
      category: "privilege",
      severity: offHours.length > 0 ? "medium" : "low",
      title: `${items.length} privilege grant(s) by ${actor}`,
      summary:
        offHours.length > 0
          ? `${offHours.length} of them between 00:00–05:00 UTC. Verify these were intentional.`
          : "Routine elevation activity. Review if the granter or targets are unexpected.",
      actorUsername: actor === "system" ? null : actor,
      ip: null,
      count: items.length,
      ...span(items),
      events: [...new Set(items.map((r) => r.event))],
    });
  }
  return out;
}

const SECRET_EVENTS = new Set(["PASSWORD_REVEALED", "PASSWORD_COPIED"]);

/** Bulk credential reads by one actor inside an hour. */
function massSecretAccess(rows: AuditRecord[]): ThreatFinding[] {
  const out: ThreatFinding[] = [];
  const reads = rows.filter((r) => SECRET_EVENTS.has(r.event));
  for (const [actor, items] of groupBy(reads, (r) => r.actorUsername ?? "system")) {
    if (actor === "system" || items.length < 5) continue;
    const times = items.map((r) => r.createdAt.getTime()).sort((a, b) => a - b);
    let fires = false;
    for (let i = 0; i + 4 < times.length; i++) {
      if (times[i + 4]! - times[i]! <= 60 * 60000) {
        fires = true;
        break;
      }
    }
    if (!fires) continue;
    out.push({
      id: `mass-secret-access-${slug(actor)}`,
      category: "secrets",
      severity: "medium",
      title: `${actor} read credentials ${items.length} times in an hour`,
      summary: "Bulk password reveals/copies can be legitimate rotation work, or harvesting. Confirm with the operator.",
      actorUsername: actor,
      ip: null,
      count: items.length,
      ...span(items),
      events: [...new Set(items.map((r) => r.event))],
    });
  }
  return out;
}

const PRIVILEGED_EVENTS = new Set([
  ...PRIVILEGE_EVENTS,
  "USER_DELETED",
  "VM_DELETED",
  "VM_FIREWALL_CHANGED",
  "PROVISIONING_STARTED",
  "SETTINGS_CHANGED",
]);

/** Privileged actions in the 00:00–05:00 UTC dead zone. */
function offHoursActivity(rows: AuditRecord[]): ThreatFinding[] {
  const out: ThreatFinding[] = [];
  const hits = rows.filter((r) => {
    if (!PRIVILEGED_EVENTS.has(r.event)) return false;
    const h = r.createdAt.getUTCHours();
    return h >= 0 && h < 5;
  });
  for (const [actor, items] of groupBy(hits, (r) => r.actorUsername ?? "system")) {
    out.push({
      id: `off-hours-${slug(actor)}`,
      category: "anomaly",
      severity: "low",
      title: `${items.length} privileged action(s) by ${actor} at night (UTC)`,
      summary: "Off-hours admin activity. Expected for scheduled maintenance; otherwise verify.",
      actorUsername: actor === "system" ? null : actor,
      ip: null,
      count: items.length,
      ...span(items),
      events: [...new Set(items.map((r) => r.event))],
    });
  }
  return out;
}

/** Destructive or weakening infrastructure changes. */
function infraChanges(rows: AuditRecord[]): ThreatFinding[] {
  const out: ThreatFinding[] = [];
  const deletions = rows.filter((r) => r.event === "VM_DELETED");
  for (const [actor, items] of groupBy(deletions, (r) => r.actorUsername ?? "system")) {
    out.push({
      id: `vm-deletions-${slug(actor)}`,
      category: "infra",
      severity: "low",
      title: `${items.length} VM deletion(s) by ${actor}`,
      summary: "Deletions are audited per VM. Unusual volume here warrants a look.",
      actorUsername: actor === "system" ? null : actor,
      ip: null,
      count: items.length,
      ...span(items),
      events: ["VM_DELETED"],
    });
  }
  const weakened = rows.filter((r) => {
    if (r.event !== "VM_FIREWALL_CHANGED") return false;
    const d = r.detail as Record<string, unknown> | null;
    return d?.isolated === false;
  });
  for (const [actor, items] of groupBy(weakened, (r) => r.actorUsername ?? "system")) {
    out.push({
      id: `firewall-weakened-${slug(actor)}`,
      category: "infra",
      severity: "medium",
      title: `${actor} removed network isolation ${items.length} time(s)`,
      summary: "Guests lost default-deny protection. Confirm each removal was intentional.",
      actorUsername: actor === "system" ? null : actor,
      ip: null,
      count: items.length,
      ...span(items),
      events: ["VM_FIREWALL_CHANGED"],
    });
  }
  return out;
}

/** Reconnaissance: aggregated 4xx bursts the response hook records as SCAN_DETECTED. */
function scanFindings(rows: AuditRecord[]): ThreatFinding[] {
  const out: ThreatFinding[] = [];
  const scans = rows.filter((r) => r.event === "SCAN_DETECTED");
  for (const [ip, items] of groupBy(scans, (r) => r.ip ?? "unknown")) {
    if (ip === "unknown") continue;
    const actors = [...new Set(items.map((r) => r.actorUsername).filter((a): a is string => !!a))];
    const total = items.reduce((n, r) => {
      const d = r.detail as Record<string, unknown> | null;
      return n + (typeof d?.count === "number" ? d.count : 1);
    }, 0);
    out.push({
      id: `recon-scan-${slug(ip)}`,
      category: "brute-force",
      severity: actors.length > 0 ? "high" : "medium",
      title:
        actors.length > 0
          ? `Authenticated probing from ${ip} (${actors.join(", ")})`
          : `Reconnaissance scan from ${ip}`,
      summary:
        actors.length > 0
          ? `${total} denied/error responses across ${items.length} burst(s), some under a login — possible privilege probing.`
          : `${total} denied/error responses across ${items.length} burst(s). Block the source if it is not a known scanner or NAT egress.`,
      actorUsername: actors.length === 1 ? actors[0]! : null,
      ip,
      count: total,
      ...span(items),
      events: ["SCAN_DETECTED"],
    });
  }
  return out;
}

export interface LiveVmPower {
  vmId: string | null;
  vmid: number;
  node: string;
  running: boolean;
}

const START_EVENTS = new Set(["VM_STARTED", "VM_AUTO_STARTED", "VM_CREATED", "PROVISIONING_STARTED"]);

/**
 * Guests running in Proxmox with no ProxVM-recorded start inside the window:
 * powered on directly in Proxmox (or before the window). Stopped guests are
 * not flagged — shutdowns have their own audit trail and absence of a
 * running guest is not suspicious.
 */
export function detectOutOfBand(
  rows: AuditRecord[],
  live: LiveVmPower[],
  nowMs = Date.now(),
  opts?: ThreatDetectOptions,
): ThreatFinding[] {
  const windowed = windowStart(rows, nowMs, opts?.windowDays ?? 7);
  const startedVmIds = new Set(
    windowed.filter((r) => r.vmId && START_EVENTS.has(r.event)).map((r) => r.vmId as string),
  );
  const out: ThreatFinding[] = [];
  for (const vm of live) {
    if (!vm.running || !vm.vmId || startedVmIds.has(vm.vmId)) continue;
    out.push({
      id: `out-of-band-${vm.vmid}`,
      category: "anomaly",
      severity: "medium",
      title: `VM ${vm.vmid} on ${vm.node} running with no ProxVM start on record`,
      summary:
        "The guest is up in Proxmox but nothing in the window started it through ProxVM — powered on directly in Proxmox, or started before the window. Verify it was you.",
      actorUsername: null,
      ip: null,
      count: 1,
      firstSeen: new Date(nowMs),
      lastSeen: new Date(nowMs),
      events: [],
    });
  }
  return out;
}

export const SEVERITY_RANK: Record<ThreatSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Runs every rule over windowed rows. Pure: same rows + now = same findings. */
export function detectThreats(rows: AuditRecord[], nowMs = Date.now(), opts?: ThreatDetectOptions): ThreatFinding[] {
  const windowed = stripSharedEgress(windowStart(rows, nowMs, opts?.windowDays ?? 7), opts?.sharedEgressIps);
  const findings = [
    ...bruteForceAccounts(windowed),
    ...passwordSpray(windowed),
    ...compromisedLogin(windowed),
    ...scanFindings(windowed),
    ...lockedAccountProbes(windowed),
    ...privilegeGrants(windowed),
    ...massSecretAccess(windowed),
    ...offHoursActivity(windowed),
    ...infraChanges(windowed),
  ];
  findings.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.lastSeen.getTime() - a.lastSeen.getTime(),
  );
  return findings;
}

export const THREAT_WEBHOOK_URL_KEY = "threats.webhook_url";
export const THREAT_MIN_SEVERITY_KEY = "threats.min_severity";
export const THREAT_ALERTED_IDS_KEY = "threats.alerted_ids";

/**
 * SSRF guard for the operator-configured webhook. Only http(s) targets are
 * allowed and cloud metadata endpoints are refused outright. Private-range
 * hosts are permitted on purpose (homelab webhooks live on the LAN) — the
 * URL is only ever settable by settings.manage holders, so the remaining
 * trust is in the operator, not the network.
 */
/**
 * True for loopback, unspecified, link-local, and unique-local IPv6
 * (fc00::/7) hosts in any textual form: dotted, decimal (2130706433),
 * octal/hex (0177.0.0.1, 0x7f.0.0.1), IPv6 and IPv4-mapped IPv6. IPv4
 * private LAN ranges are intentionally NOT blocked — homelab webhooks live
 * on the LAN by design (see module contract above). This mirrors the
 * server-destination guard in util/ssrf.ts so both paths agree.
 */
export function isBlockedWebhookHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "metadata.google.internal" || host.endsWith(".metadata.google.internal")) {
    return true;
  }
  // Encoded-quad DNS (nip.io/sslip.io style): 169.254.169.254.nip.io would
  // otherwise dodge the literal check and resolve to link-local.
  const quadPrefix = host.match(/^(\d{1,3}(?:\.\d{1,3}){3})\./);
  if (quadPrefix) {
    const octets = quadPrefix[1]!.split(".").map(Number);
    if (octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      const [a, b] = octets;
      if (a === 127 || a === 0) return true;
      if (a === 169 && b === 254) return true;
    }
  }
  // IPv4-mapped IPv6, in dotted form (::ffff:127.0.0.1) or WHATWG-normalized
  // hex form (::ffff:7f00:1). Both denote the same 32-bit address.
  const mapped = host.match(/^(?:::ffff:)(.+)$/);
  let v4 = mapped ? mapped[1]! : host;
  if (mapped && v4.includes(":")) {
    const groups = v4.split(":");
    if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) {
      const n = (parseInt(groups[0]!, 16) << 16) | parseInt(groups[1]!, 16);
      v4 = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    } else {
      return true;
    }
  }
  const numeric = (() => {
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
    // Decimal dword (2130706433) and short forms (a.b, a.b.c) per inet_aton.
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
  })();
  if (numeric) {
    const [a, b] = numeric;
    if (a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // IPv6 literals.
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (host.startsWith("fe80:")) return true;
    if (host.startsWith("fc") || host.startsWith("fd")) return true;
    return false;
  }
  return false;
}

/** Rejects non-http(s), loopback/link-local/metadata webhook targets. */
export function assertSafeWebhookUrl(raw: string): string {
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw AppError.validation("Webhook URL must be a valid http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw AppError.validation("Webhook URL must use http or https");
  }
  if (isBlockedWebhookHost(parsed.hostname)) {
    throw AppError.validation("Webhook URL must not target loopback, link-local, or cloud metadata endpoints");
  }
  return url;
}

export interface ThreatAlertDeps {
  settings: Pick<SettingsService, "getPlain" | "set">;
  audit: Pick<AuditService, "list">;
  /** Shared egress hops (the PROXVM_TRUST_PROXY list); see ThreatDetectOptions. */
  sharedEgressIps?: string[];
}

async function defaultPost(url: string, body: unknown): Promise<void> {
  // Resolve-and-pin: the hostname is resolved fresh and every answer must be
  // safe, closing DNS-rebinding (attacker.com → 169.254.169.254) at send
  // time. Redirects stay manual (see below).
  const first = new URL(url);
  let resolved: string[];
  try {
    resolved = (await dnsLookup(first.hostname, { all: true })).map((r) => r.address);
  } catch {
    throw new Error("Webhook hostname does not resolve");
  }
  if (resolved.length === 0 || resolved.some((addr) => isBlockedWebhookHost(addr))) {
    throw new Error("Webhook hostname resolves to a blocked address");
  }
  // Manual redirects: fetch() would otherwise follow a compromised/rotated
  // webhook URL straight to an internal target. One https upgrade hop is
  // honored (common for http→https); anything else fails closed.
  let current = url;
  for (let hop = 0; hop < 2; hop++) {
    const res = await fetch(current, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: "manual",
    });
    if (res.status !== 301 && res.status !== 302 && res.status !== 307 && res.status !== 308) {
      if (!res.ok) throw new Error(`Webhook POST failed with status ${res.status}`);
      return;
    }
    const location = res.headers.get("location");
    if (!location) throw new Error("Webhook redirect without Location");
    const next = new URL(location, current);
    if (next.protocol !== "https:" || isBlockedWebhookHost(next.hostname)) {
      throw new Error("Webhook redirect target refused");
    }
    // Re-resolve the redirect target: the initial DNS pin does not cover
    // hops, so a benign first hop must not bounce into blocked space.
    try {
      const hopAddrs = (await dnsLookup(next.hostname, { all: true })).map((r) => r.address);
      if (hopAddrs.length === 0 || hopAddrs.some((addr) => isBlockedWebhookHost(addr))) {
        throw new Error("Webhook redirect target resolves to a blocked address");
      }
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "Webhook redirect target does not resolve");
    }
    current = next.toString();
  }
  throw new Error("Webhook redirect limit exceeded");
}

/**
 * Evaluates the last day of audit events and POSTs fresh findings at or
 * above the configured minimum severity. Finding ids are deterministic, so
 * already-alerted ids stored in settings dedupe across ticks. Shared egress
 * hops are supplied via deps and never count as attacker identities.
 * Fail-open: throws on transport errors (the ticker logs and continues).
 */
export async function evaluateThreatAlerts(
  deps: ThreatAlertDeps,
  post: (url: string, body: unknown) => Promise<void> = defaultPost,
  nowMs = Date.now(),
): Promise<{ evaluated: number; fired: number }> {
  const rawUrl = await deps.settings.getPlain(THREAT_WEBHOOK_URL_KEY);
  if (!rawUrl?.trim()) return { evaluated: 0, fired: 0 };
  const url = assertSafeWebhookUrl(rawUrl);
  const minSev = ((await deps.settings.getPlain(THREAT_MIN_SEVERITY_KEY)) ?? "high").trim().toLowerCase();
  const minRank = SEVERITY_RANK[minSev as ThreatSeverity] ?? SEVERITY_RANK.high;
  const rows = await deps.audit.list({ limit: 5000, since: new Date(nowMs - DAY_MS) });
  const findings = detectThreats(rows, nowMs, { windowDays: 1, sharedEgressIps: deps.sharedEgressIps }).filter(
    (f) => SEVERITY_RANK[f.severity] <= minRank,
  );
  if (!findings.length) return { evaluated: 0, fired: 0 };
  let alerted: string[] = [];
  try {
    const parsed: unknown = JSON.parse((await deps.settings.getPlain(THREAT_ALERTED_IDS_KEY)) ?? "[]");
    if (Array.isArray(parsed)) alerted = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    alerted = [];
  }
  const fresh = findings.filter((f) => !alerted.includes(f.id));
  if (!fresh.length) return { evaluated: findings.length, fired: 0 };
  await post(url, {
    source: "proxvm",
    kind: "threats",
    evaluatedAt: new Date(nowMs).toISOString(),
    findings: fresh.map((f) => ({
      id: f.id,
      severity: f.severity,
      category: f.category,
      title: f.title,
      summary: f.summary,
      actor: f.actorUsername,
      ip: f.ip,
      count: f.count,
      firstSeen: f.firstSeen.toISOString(),
      lastSeen: f.lastSeen.toISOString(),
      events: f.events,
    })),
  });
  await deps.settings.set(THREAT_ALERTED_IDS_KEY, JSON.stringify([...alerted, ...fresh.map((f) => f.id)].slice(-200)), {
    category: "system",
  });
  return { evaluated: findings.length, fired: fresh.length };
}

/**
 * Logins from an (actor, ip) pair with no earlier login on record: a new
 * device, network, or credential-stuffing success from an unfamiliar egress.
 * Needs history beyond the findings window, so it queries directly. Pairs
 * whose ip is a shared egress address are skipped — the hop is not a device,
 * and every tunneled user would otherwise read as "first login".
 */
export async function findNewIpLogins(
  db: Pool,
  sinceDays: number,
  opts?: Pick<ThreatDetectOptions, "sharedEgressIps">,
): Promise<ThreatFinding[]> {
  const since = new Date(Date.now() - sinceDays * DAY_MS);
  const recent = await db.query<{ actor_username: string; ip: string; last_seen: Date; logins: string }>(
    `SELECT actor_username, ip, MAX(created_at) AS last_seen, COUNT(*)::text AS logins
       FROM audit_logs
      WHERE event = 'LOGIN' AND created_at >= $1
        AND actor_username IS NOT NULL AND ip IS NOT NULL
      GROUP BY actor_username, ip`,
    [since.toISOString()],
  );
  const out: ThreatFinding[] = [];
  for (const row of recent.rows) {
    if (opts?.sharedEgressIps?.length && isSharedEgressIp(row.ip, opts.sharedEgressIps)) continue;
    const older = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM audit_logs
        WHERE event = 'LOGIN' AND actor_username = $1 AND ip = $2 AND created_at < $3`,
      [row.actor_username, row.ip, since.toISOString()],
    );
    if (Number(older.rows[0]?.c ?? "0") > 0) continue;
    out.push({
      id: `new-ip-${slug(row.actor_username)}-${slug(row.ip)}`,
      category: "anomaly",
      severity: "low",
      title: `First login for ${row.actor_username} from ${row.ip}`,
      summary: `${row.logins} login(s) in the window from an IP this account never used before. New device/VPN egress, or a session worth verifying.`,
      actorUsername: row.actor_username,
      ip: row.ip,
      count: Number(row.logins),
      firstSeen: row.last_seen,
      lastSeen: row.last_seen,
      events: ["LOGIN"],
    });
  }
  out.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
  return out;
}
