import type { Pool } from "pg";
import { AppError } from "../util/errors.js";
import { newId } from "../util/misc.js";
import type { SettingsService } from "./settings.js";

export interface PowerPeriod {
  id: string;
  vmId: string;
  startedAt: Date;
  endedAt: Date | null;
}

export interface VmMonthlyUsage {
  vmId: string;
  vmName: string;
  hours: number;
}

export type TicketStatus = "open" | "answered" | "closed";

export interface SupportTicket {
  id: string;
  userId: string;
  username: string;
  title: string;
  body: string;
  status: TicketStatus;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

function toPeriod(row: {
  id: string;
  vm_id: string;
  started_at: Date;
  ended_at: Date | null;
}): PowerPeriod {
  return { id: row.id, vmId: row.vm_id, startedAt: row.started_at, endedAt: row.ended_at };
}

// -- Power periods (usage metering) ------------------------------------------
// Rows are written only on running/stopped transitions, so the table stays
// tiny: one row per power cycle, not one per poll. All three functions are
// idempotent — safe to call from both action routes and the reconciler.

export async function openPowerPeriod(db: Pool, vmId: string): Promise<PowerPeriod> {
  const existing = await db.query(
    "SELECT * FROM vm_power_periods WHERE vm_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
    [vmId],
  );
  if (existing.rows[0]) return toPeriod(existing.rows[0]);
  const created = await db.query(
    "INSERT INTO vm_power_periods (id, vm_id) VALUES ($1, $2) RETURNING *",
    [newId(), vmId],
  );
  return toPeriod(created.rows[0]);
}

export async function closePowerPeriod(db: Pool, vmId: string): Promise<number> {
  const result = await db.query(
    "UPDATE vm_power_periods SET ended_at = NOW() WHERE vm_id = $1 AND ended_at IS NULL",
    [vmId],
  );
  return result.rowCount ?? 0;
}

/** Reconcile one VM against its live Proxmox power state. Returns what changed. */
export async function reconcileVmPower(
  db: Pool,
  vmId: string,
  running: boolean,
): Promise<"opened" | "closed" | "unchanged"> {
  const open = await db.query("SELECT id FROM vm_power_periods WHERE vm_id = $1 AND ended_at IS NULL LIMIT 1", [
    vmId,
  ]);
  const hasOpen = !!open.rows[0];
  if (running && !hasOpen) {
    await openPowerPeriod(db, vmId);
    return "opened";
  }
  if (!running && hasOpen) {
    await closePowerPeriod(db, vmId);
    return "closed";
  }
  return "unchanged";
}

/** Per-VM powered-on hours overlapping a calendar month (YYYY-MM). Open periods count up to now. */
export async function monthlyUsage(db: Pool, month: string): Promise<VmMonthlyUsage[]> {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) {
    throw AppError.validation("month must be YYYY-MM");
  }
  // Month bounds are computed here (not in SQL) so the query stays portable:
  // pg-mem lacks LEAST/GREATEST/EXTRACT-on-intervals used by fancier variants.
  const monthStart = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  const monthEnd = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
  const now = new Date();
  const result = await db.query<{
    vm_id: string;
    vm_name: string;
    started_at: Date;
    ended_at: Date | null;
  }>(
    `SELECT p.vm_id, v.name AS vm_name, p.started_at, p.ended_at
     FROM vm_power_periods p
     JOIN vms v ON v.id = p.vm_id
     WHERE p.started_at < $2 AND (p.ended_at IS NULL OR p.ended_at > $1)
     ORDER BY v.name ASC, p.started_at ASC`,
    [monthStart.toISOString(), monthEnd.toISOString()],
  );
  const seconds = new Map<string, { vmName: string; total: number }>();
  for (const row of result.rows) {
    const start = new Date(row.started_at).getTime();
    const end = row.ended_at ? new Date(row.ended_at).getTime() : now.getTime();
    const overlap = Math.max(0, Math.min(end, monthEnd.getTime()) - Math.max(start, monthStart.getTime())) / 1000;
    if (overlap <= 0) continue;
    const entry = seconds.get(row.vm_id) ?? { vmName: row.vm_name, total: 0 };
    entry.total += overlap;
    seconds.set(row.vm_id, entry);
  }
  return [...seconds.entries()]
    .map(([vmId, v]) => ({ vmId, vmName: v.vmName, hours: Math.round((v.total / 3600) * 100) / 100 }))
    .sort((a, b) => b.hours - a.hours);
}

// -- Quotas -------------------------------------------------------------------

export async function getUserQuota(db: Pool, userId: string): Promise<number | null> {
  const result = await db.query<{ max_vms: number | null }>("SELECT max_vms FROM users WHERE id = $1", [userId]);
  return result.rows[0]?.max_vms ?? null;
}

export async function setUserQuota(db: Pool, userId: string, maxVms: number | null): Promise<number | null> {
  if (maxVms !== null && (!Number.isInteger(maxVms) || maxVms < 0)) {
    throw AppError.validation("maxVms must be a non-negative integer or null (unlimited)");
  }
  const result = await db.query<{ max_vms: number | null }>("UPDATE users SET max_vms = $2, updated_at = NOW() WHERE id = $1 RETURNING max_vms", [
    userId,
    maxVms,
  ]);
  if (!result.rows[0]) throw AppError.notFound("User not found");
  return result.rows[0].max_vms;
}

/** Live (non-deleted) VMs created by a user. Assigned-but-not-owned VMs don't count. */
export async function countUserVms(db: Pool, userId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM vms WHERE created_by_user_id = $1 AND deleted_at IS NULL",
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

// -- Support tickets ------------------------------------------------------------

const TICKET_STATUSES: TicketStatus[] = ["open", "answered", "closed"];

export async function createTicket(db: Pool, userId: string, title: string, body: string): Promise<SupportTicket> {
  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  if (cleanTitle.length < 1 || cleanTitle.length > 120) {
    throw AppError.validation("Title must be 1–120 characters");
  }
  if (cleanBody.length < 1 || cleanBody.length > 4000) {
    throw AppError.validation("Body must be 1–4000 characters");
  }
  const created = await db.query(
    `INSERT INTO support_tickets (id, user_id, title, body)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [newId(), userId, cleanTitle, cleanBody],
  );
  return toTicket(created.rows[0]);
}

export async function listTickets(
  db: Pool,
  opts: { userId?: string; status?: TicketStatus; limit?: number },
): Promise<SupportTicket[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.userId) {
    params.push(opts.userId);
    clauses.push(`t.user_id = $${params.length}`);
  }
  if (opts.status) {
    if (!TICKET_STATUSES.includes(opts.status)) throw AppError.validation("Invalid status filter");
    params.push(opts.status);
    clauses.push(`t.status = $${params.length}`);
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const result = await db.query(
    `SELECT t.*, u.username FROM support_tickets t
     JOIN users u ON u.id = t.user_id
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY t.created_at DESC LIMIT ${limit}`,
    params,
  );
  return result.rows.map(toTicket);
}

export async function setTicketStatus(
  db: Pool,
  ticketId: string,
  status: TicketStatus,
  actorUserId: string,
): Promise<SupportTicket> {
  if (!TICKET_STATUSES.includes(status)) throw AppError.validation("Invalid status");
  const result = await db.query(
    `UPDATE support_tickets
     SET status = $2, updated_at = NOW(),
         closed_at = CASE WHEN $2 = 'closed' THEN NOW() ELSE NULL END,
         closed_by = CASE WHEN $2 = 'closed' THEN $3 ELSE NULL END
     WHERE id = $1
     RETURNING *`,
    [ticketId, status, actorUserId],
  );
  if (!result.rows[0]) throw AppError.notFound("Ticket not found");
  const row = result.rows[0];
  const username = await db.query<{ username: string }>("SELECT username FROM users WHERE id = $1", [row.user_id]);
  return toTicket({ ...row, username: username.rows[0]?.username ?? "?" });
}

function toTicket(row: {
  id: string;
  user_id: string;
  username?: string;
  title: string;
  body: string;
  status: TicketStatus;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}): SupportTicket {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username ?? "?",
    title: row.title,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

// -- Announcements (settings-backed, no schema) ----------------------------------

export type AnnouncementLevel = "info" | "warn";

export async function getAnnouncement(
  settings: Pick<import("./settings.js").SettingsService, "get">,
): Promise<{ text: string; level: AnnouncementLevel } | null> {
  const [text, level] = await Promise.all([
    settings.get("app.announcement_text"),
    settings.get("app.announcement_level"),
  ]);
  if (!text?.value.trim()) return null;
  return { text: text.value.slice(0, 500), level: level?.value === "warn" ? "warn" : "info" };
}

export async function setAnnouncement(
  settings: Pick<SettingsService, "set">,
  text: string | null,
  level: AnnouncementLevel,
): Promise<void> {
  const clean = (text ?? "").trim().slice(0, 500);
  await settings.set("app.announcement_text", clean, { category: "system" });
  await settings.set("app.announcement_level", level === "warn" ? "warn" : "info", { category: "system" });
}
