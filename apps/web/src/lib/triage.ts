/* =====================================================================
 * Admin triage helpers: ordering, filtering and queue pressure for the
 * threat board and the support queue.
 *
 * Pure functions on purpose — both pages share one definition of "urgent"
 * and "waiting longest", and the ordering rules are unit-tested without a
 * renderer (this workspace has no jsdom; see vitest.config.ts).
 * ===================================================================== */

export type Severity = "critical" | "high" | "medium" | "low";
export type TicketStatus = "open" | "answered" | "closed";

/** Lower rank = more urgent. Table order matches the triage order. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const TICKET_RANK: Record<TicketStatus, number> = { open: 0, answered: 1, closed: 2 };

const DAY_MS = 86_400_000;

/** Queue-pressure thresholds: 2 days amber, 7 days red (header and rows agree). */
export const WAITING_WARN_MS = 2 * DAY_MS;
export const WAITING_ERR_MS = 7 * DAY_MS;

/* ------------------------------- threats ------------------------------ */

export interface ThreatLike {
  severity: Severity;
  category: string;
  title: string;
  summary?: string;
  actorUsername: string | null;
  ip: string | null;
  events?: string[];
  lastSeen: string;
}

function parseTime(value: string | undefined | null): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

/** Split a free-text query into lowercase tokens (empty query = no filter). */
function tokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Free-text match across the fields an admin actually pastes in: actor,
 * IP, finding title, category and the source audit events. All tokens must
 * hit, so "alice login" narrows instead of widening.
 */
export function matchesThreat(f: ThreatLike, query: string): boolean {
  const q = tokens(query);
  if (q.length === 0) return true;
  const haystack = [f.title, f.summary ?? "", f.category, f.actorUsername ?? "", f.ip ?? "", ...(f.events ?? [])]
    .join(" ")
    .toLowerCase();
  return q.every((t) => haystack.includes(t));
}

/**
 * Sort findings for review.
 * - "severity": critical first, then newest inside each severity (default).
 * - "recent": purely newest-first, for "what just happened?" moments.
 */
export function sortThreats<T extends ThreatLike>(items: readonly T[], mode: "severity" | "recent"): T[] {
  const out = items.slice();
  if (mode === "recent") {
    out.sort((a, b) => parseTime(b.lastSeen) - parseTime(a.lastSeen));
    return out;
  }
  out.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      parseTime(b.lastSeen) - parseTime(a.lastSeen),
  );
  return out;
}

/** Counts that drive the triage banner (urgent = critical + high). */
export function urgentCounts(items: readonly ThreatLike[]): { critical: number; high: number; urgent: number } {
  let critical = 0;
  let high = 0;
  for (const f of items) {
    if (f.severity === "critical") critical++;
    else if (f.severity === "high") high++;
  }
  return { critical, high, urgent: critical + high };
}

/* ------------------------------- tickets ------------------------------ */

export interface TicketLike {
  id: string;
  username: string;
  title: string;
  body: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt?: string;
}

export function ticketCounts(items: readonly TicketLike[]): Record<TicketStatus, number> & { total: number } {
  const counts = { open: 0, answered: 0, closed: 0, total: items.length };
  for (const t of items) counts[t.status]++;
  return counts;
}

/** Age of the oldest still-open ticket in ms, or null when the queue is clear. */
export function oldestOpenAgeMs(items: readonly TicketLike[], now: number = Date.now()): number | null {
  let oldest: number | null = null;
  for (const t of items) {
    if (t.status !== "open") continue;
    const age = now - parseTime(t.createdAt);
    if (oldest === null || age > oldest) oldest = age;
  }
  return oldest;
}

/**
 * Sort the queue.
 * - "waiting": open first, longest-waiting first, so nobody is forgotten;
 *   answered next; closed last, newest-closed first (they need no action).
 * - "newest": newest activity first, for a quick "what came in today?".
 */
export function sortTickets<T extends TicketLike>(items: readonly T[], mode: "waiting" | "newest"): T[] {
  const out = items.slice();
  if (mode === "newest") {
    out.sort((a, b) => parseTime(b.updatedAt ?? b.createdAt) - parseTime(a.updatedAt ?? a.createdAt));
    return out;
  }
  out.sort((a, b) => {
    const rank = TICKET_RANK[a.status] - TICKET_RANK[b.status];
    if (rank !== 0) return rank;
    if (a.status === "closed") return parseTime(b.createdAt) - parseTime(a.createdAt);
    return parseTime(a.createdAt) - parseTime(b.createdAt);
  });
  return out;
}

/** Match a ticket by reporter, summary or body text (case-insensitive, all tokens). */
export function matchesTicket(t: TicketLike, query: string): boolean {
  const q = tokens(query);
  if (q.length === 0) return true;
  const haystack = `${t.username} ${t.title} ${t.body}`.toLowerCase();
  return q.every((token) => haystack.includes(token));
}

/**
 * Pressure tone for a still-open ticket: 2 days amber, 7 days red. The
 * queue header uses the same thresholds so badge and banner agree.
 */
export function waitingTone(createdAt: string, now: number = Date.now()): "neutral" | "warn" | "err" {
  const age = ageMs(createdAt, now);
  if (age >= WAITING_ERR_MS) return "err";
  if (age >= WAITING_WARN_MS) return "warn";
  return "neutral";
}

/** Milliseconds since a timestamp; unparseable values count as "very old". */
export function ageMs(value: string, now: number = Date.now()): number {
  return now - parseTime(value);
}

/** Compact age for the queue header ("45m", "6h", "3d"); "—" when clear. */
export function fmtAge(ageMs: number | null): string {
  if (ageMs === null) return "—";
  const mins = Math.round(ageMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
