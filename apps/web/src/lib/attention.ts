/* =====================================================================
 * Admin attention: what needs a human, in one place.
 *
 * One polled endpoint (`GET /api/attention`) feeds three surfaces — the
 * sidebar badges, the dashboard strip and the command palette — so an admin
 * sees the same numbers everywhere. The shaping lives here as pure
 * functions: this workspace has no jsdom, so the rules are unit-tested
 * without a renderer (see vitest.config.ts).
 * ===================================================================== */

import { fmtAge, waitingTone } from "./triage.js";

export interface ThreatAttention {
  critical: number;
  high: number;
  medium: number;
  low: number;
  /** critical + high — the two severities that are actually triaged first. */
  urgent: number;
}

export interface TicketAttention {
  open: number;
  answered: number;
  closed: number;
  oldestOpenAt: string | null;
}

export interface AttentionResponse {
  generatedAt: string;
  /** null when the viewer may not read audit (or the scan failed). */
  threats: ThreatAttention | null;
  /** null when the viewer may not manage users (or the query failed). */
  tickets: TicketAttention | null;
}

export type AttentionTone = "warn" | "err";

/** Compact badge for one sidebar link. */
export interface AttentionBadge {
  count: number;
  tone: AttentionTone;
  /** Tooltip: says what the number means, not just the number. */
  title: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Severity breakdown, low-counts omitted, for tooltips and the strip. */
export function threatBreakdown(t: ThreatAttention): string {
  const parts: string[] = [];
  if (t.critical) parts.push(`${t.critical} critical`);
  if (t.high) parts.push(`${t.high} high`);
  if (!parts.length) {
    if (t.medium) parts.push(`${t.medium} medium`);
    if (t.low) parts.push(`${t.low} low`);
  }
  return parts.join(", ");
}

/**
 * Sidebar badges keyed by destination. Only non-zero work is returned, so a
 * quiet install renders a nav that looks exactly like the old one.
 */
export function attentionBadges(
  attention: AttentionResponse | null | undefined,
  now: number = Date.now(),
): Record<string, AttentionBadge> {
  const badges: Record<string, AttentionBadge> = {};
  const threats = attention?.threats;
  if (threats && threats.urgent > 0) {
    const top = threatBreakdown(threats);
    badges["/system"] = {
      count: threats.urgent,
      tone: threats.critical > 0 ? "err" : "warn",
      title: `${plural(threats.urgent, "urgent threat finding")} in the last 24h${top ? ` (${top})` : ""}`,
    };
  }
  const tickets = attention?.tickets;
  if (tickets && tickets.open > 0) {
    const age = tickets.oldestOpenAt ? now - Date.parse(tickets.oldestOpenAt) : null;
    const waiting = age !== null && Number.isFinite(age) ? fmtAge(age) : null;
    // Same aging rule as the support queue itself (2d amber, 7d red), so the
    // badge and the queue header can never disagree.
    const tone: AttentionTone = tickets.oldestOpenAt && waitingTone(tickets.oldestOpenAt, now) === "err" ? "err" : "warn";
    badges["/tickets"] = {
      count: tickets.open,
      tone,
      title: `${plural(tickets.open, "open ticket")}${waiting ? `, oldest waiting ${waiting}` : ""}`,
    };
  }
  return badges;
}

/** One row of the dashboard's "Needs attention" strip. */
export interface AttentionItem {
  key: "threats" | "tickets";
  to: string;
  tone: AttentionTone;
  title: string;
  detail: string;
  cta: string;
}

/**
 * Rows for the dashboard strip, most urgent first. Empty array = nothing to
 * do, and the strip does not render at all.
 */
export function attentionItems(
  attention: AttentionResponse | null | undefined,
  now: number = Date.now(),
): AttentionItem[] {
  const items: AttentionItem[] = [];

  const threats = attention?.threats;
  if (threats && threats.urgent > 0) {
    const top = threatBreakdown(threats);
    items.push({
      key: "threats",
      to: "/system?tab=threats",
      tone: threats.critical > 0 ? "err" : "warn",
      title: `${plural(threats.urgent, "urgent threat finding")} to triage`,
      detail: top ? `${top} in the last 24 hours.` : "Review the board and audit trail.",
      cta: "Open threat board",
    });
  }

  const tickets = attention?.tickets;
  if (tickets && tickets.open > 0) {
    const age = tickets.oldestOpenAt ? now - Date.parse(tickets.oldestOpenAt) : null;
    const waiting = age !== null && Number.isFinite(age) ? fmtAge(age) : null;
    items.push({
      key: "tickets",
      to: "/tickets",
      tone: tickets.oldestOpenAt && waitingTone(tickets.oldestOpenAt, now) === "err" ? "err" : "warn",
      title: `${plural(tickets.open, "ticket")} waiting on a reply`,
      detail: waiting ? `Oldest has waited ${waiting}.` : "Nobody has picked these up yet.",
      cta: "Open support queue",
    });
  }

  return items;
}
