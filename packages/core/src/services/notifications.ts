import { newId, isUuid } from "../util/misc.js";
import type { Queryable } from "../db/pool.js";
import { AppError } from "../util/errors.js";

// ---------------------------------------------------------------------------
// In-app notifications (delivery log, NOT audit).
//
// Audit answers "what happened" for investigators; notifications answer
// "what needs my attention" for humans. Rows are written at the moment of
// the event (ticket filed, registration requested, user created, threat
// fired, backup failed) and consumed by the topbar bell. Audience is
// either "admins" (visible to users.manage holders) or one user id
// (personal delivery). Listing is capped; read rows older than 90 days
// are pruned on read so the table cannot grow without bound.
// ---------------------------------------------------------------------------

export const ADMIN_AUDIENCE = "admins";

export const NOTIFICATION_KINDS = [
  "threat",
  "ticket",
  "registration",
  "user",
  "backup",
  "system",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface Notification {
  id: string;
  audience: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotifyInput {
  audience: string;
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

function toNotification(row: Record<string, unknown>): Notification {
  return {
    id: String(row.id),
    audience: String(row.audience),
    kind: row.kind as NotificationKind,
    title: String(row.title),
    body: (row.body as string | null) ?? null,
    link: (row.link as string | null) ?? null,
    readAt: row.read_at ? new Date(row.read_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

export function assertValidAudience(audience: string): void {
  if (audience !== ADMIN_AUDIENCE && !isUuid(audience)) {
    throw AppError.validation("audience must be 'admins' or a user id");
  }
}

/** Fan-out helper: one row per audience (e.g. admins + affected user). */
export async function notify(db: Queryable, input: NotifyInput): Promise<Notification>;
export async function notify(db: Queryable, inputs: NotifyInput[]): Promise<Notification[]>;
export async function notify(
  db: Queryable,
  audiences: string[],
  input: Omit<NotifyInput, "audience">,
): Promise<Notification[]>;
export async function notify(
  db: Queryable,
  inputOrAudiences: NotifyInput | NotifyInput[] | string[],
  input?: Omit<NotifyInput, "audience">,
): Promise<Notification | Notification[]> {
  const single = !Array.isArray(inputOrAudiences);
  const items: NotifyInput[] = single
    ? [inputOrAudiences as NotifyInput]
    : (inputOrAudiences as Array<NotifyInput | string>).map((entry) =>
        typeof entry === "string" ? { ...input!, audience: entry } : entry,
      );
  const out: Notification[] = [];
  for (const item of items) {
    assertValidAudience(item.audience);
    if (!NOTIFICATION_KINDS.includes(item.kind as NotificationKind)) {
      throw AppError.validation(`kind must be one of: ${NOTIFICATION_KINDS.join(", ")}`);
    }
    if (!item.title.trim() || item.title.length > 160) {
      throw AppError.validation("title must be 1-160 characters");
    }
    const id = newId();
    await db.query(
      `INSERT INTO notifications (id, audience, kind, title, body, link)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, item.audience, item.kind, item.title.trim(), item.body?.slice(0, 2000) ?? null, item.link?.slice(0, 512) ?? null],
    );
    const rows = await db.query("SELECT * FROM notifications WHERE id = $1", [id]);
    out.push(toNotification(rows.rows[0] as Record<string, unknown>));
  }
  return single ? out[0]! : out;
}

export interface NotificationViewer {
  userId: string;
  isAdmin: boolean;
}

function audienceFilter(viewer: NotificationViewer): { clause: string; params: unknown[] } {
  // Admins see the admin queue plus anything addressed to them personally;
  // everyone else sees only their own rows. Never the reverse.
  if (viewer.isAdmin) {
    return { clause: "(audience = $1 OR audience = $2)", params: [ADMIN_AUDIENCE, viewer.userId] };
  }
  return { clause: "audience = $1", params: [viewer.userId] };
}

export async function listNotifications(
  db: Queryable,
  viewer: NotificationViewer,
  limit = 20,
): Promise<Notification[]> {
  const capped = Math.min(Math.max(limit, 1), 50);
  const { clause, params } = audienceFilter(viewer);
  const result = await db.query(
    `SELECT * FROM notifications WHERE ${clause} ORDER BY created_at DESC LIMIT $${params.length + 1}`,
    [...params, capped],
  );
  // Best-effort retention: drop read rows older than 90 days on every read.
  await db
    .query("DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < NOW() - interval '90 days'")
    .catch(() => undefined);
  return result.rows.map((r) => toNotification(r as Record<string, unknown>));
}

export async function unreadNotificationCount(db: Queryable, viewer: NotificationViewer): Promise<number> {
  const { clause, params } = audienceFilter(viewer);
  const result = await db.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM notifications WHERE ${clause} AND read_at IS NULL`,
    params,
  );
  return Number(result.rows[0]?.c ?? "0");
}

/** Mark rows read — scoped to rows the viewer can actually see. */
export async function markNotificationsRead(
  db: Queryable,
  viewer: NotificationViewer,
  opts: { ids?: string[]; all?: boolean } = {},
): Promise<number> {
  const { clause, params } = audienceFilter(viewer);
  if (opts.all) {
    const result = await db.query(
      `UPDATE notifications SET read_at = NOW() WHERE ${clause} AND read_at IS NULL`,
      params,
    );
    return result.rowCount ?? 0;
  }
  const ids = [...new Set(opts.ids ?? [])].filter(isUuid).slice(0, 100);
  if (!ids.length) return 0;
  const placeholders = ids.map((_, i) => `$${params.length + 1 + i}`).join(", ");
  const result = await db.query(
    `UPDATE notifications SET read_at = NOW() WHERE ${clause} AND id IN (${placeholders}) AND read_at IS NULL`,
    [...params, ...ids],
  );
  return result.rowCount ?? 0;
}
