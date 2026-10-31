/* =====================================================================
 * Notification presentation rules.
 *
 * The notification table has no severity column — only `kind` — so tone is
 * derived here, once, instead of being guessed per component. Same reason
 * the filtering/ordering lives here: it is unit-tested without a renderer
 * (this workspace has no jsdom; see vitest.config.ts).
 * ===================================================================== */

export type NotifyTone = "err" | "warn" | "info" | "neutral";

export interface NotificationLike {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * How loud a row should be.
 * - threat: err (someone may be attacking the box)
 * - ticket / backup: warn (a human is waiting, or data protection failed)
 * - registration / user: info (access changed, nothing broken yet)
 * - anything unknown: neutral, so a new kind degrades quietly instead of
 *   shipping an unstyled row.
 */
export function notificationTone(kind: string): NotifyTone {
  switch (kind) {
    case "threat":
      return "err";
    case "ticket":
    case "backup":
      return "warn";
    case "registration":
    case "user":
      return "info";
    default:
      return "neutral";
  }
}

/** Short noun for the row meta line ("Support", "Threat", …). */
export function notificationKindLabel(kind: string): string {
  switch (kind) {
    case "threat":
      return "Threat";
    case "ticket":
      return "Support";
    case "registration":
      return "Registration";
    case "user":
      return "Account";
    case "backup":
      return "Backup";
    case "system":
      return "System";
    default:
      return kind ? kind[0]!.toUpperCase() + kind.slice(1) : "Notice";
  }
}

function parseTime(value: string): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The rows the popover shows: newest first (an inbox, not a queue), and only
 * unread ones when the admin asked for that. The list is capped so a burst
 * of alerts cannot push the "mark all read" control off-screen.
 */
export function visibleNotifications<T extends NotificationLike>(
  items: readonly T[],
  opts: { unreadOnly?: boolean; limit?: number } = {},
): T[] {
  const limit = opts.limit ?? 12;
  const filtered = opts.unreadOnly ? items.filter((n) => !n.readAt) : items.slice();
  filtered.sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt));
  return filtered.slice(0, limit);
}

/**
 * True when the bell should turn red: an unread threat row is sitting in the
 * list. A 30s poll can lag the badge count, but this flag comes from the same
 * payload as the rows, so the colour and the content always agree.
 */
export function hasUnreadThreat(items: readonly NotificationLike[]): boolean {
  return items.some((n) => !n.readAt && n.kind === "threat");
}
