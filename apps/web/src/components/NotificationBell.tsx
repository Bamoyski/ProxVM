import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Bell,
  Check,
  CheckCheck,
  HardDrive,
  Info,
  LifeBuoy,
  ShieldAlert,
  User,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { api } from "../api.js";
import { Popover } from "../ui/index.js";
import { fmtRelative } from "../lib/format.js";
import {
  hasUnreadThreat,
  notificationKindLabel,
  notificationTone,
  visibleNotifications,
  type NotificationLike,
} from "../lib/notify.js";

type Notification = NotificationLike;

const KIND_ICONS: Record<string, LucideIcon> = {
  threat: ShieldAlert,
  ticket: LifeBuoy,
  registration: UserPlus,
  user: User,
  backup: HardDrive,
  system: Info,
};

function KindIcon({ kind }: { kind: string }) {
  const Icon = KIND_ICONS[kind] ?? Info;
  return <Icon size={14} className={`pv-notify-ico pv-notify-ico-${notificationTone(kind)}`} aria-hidden="true" />;
}

/**
 * Global notifications (job outcomes, admin queue). Server-scoped rows.
 *
 * Tuning choices that matter:
 * - the list refetches when the popover opens, so it is never a minute stale
 *   at the exact moment an admin looks at it;
 * - the badge turns red only for an unread *threat* — a red dot that means
 *   "any notice" trains people to ignore red;
 * - the whole row is the link, not a 12px "Open" caption;
 * - "Unread only" is a filter, not a destructive action, so switching it back
 *   costs nothing.
 */
export default function NotificationBell() {
  const qc = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data: countData } = useQuery({
    queryKey: ["notifications-unread"],
    queryFn: () => api<{ count: number }>("/notifications/unread-count"),
    refetchInterval: 30000,
    retry: false,
  });
  const { data: listData } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<{ notifications: Notification[] }>("/notifications?limit=20"),
    retry: false,
  });

  const count = countData?.count ?? 0;
  const items = listData?.notifications ?? [];
  const unreadThreat = hasUnreadThreat(items);
  const rows = visibleNotifications(items, { unreadOnly });

  const markRead = async (ids?: string[], all?: boolean) => {
    try {
      await api("/notifications/read", { method: "POST", body: ids ? { ids } : { all: !!all } });
      void qc.invalidateQueries({ queryKey: ["notifications"] });
      void qc.invalidateQueries({ queryKey: ["notifications-unread"] });
    } catch {
      // read-marking is best-effort; the list stays usable
    }
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["notifications"] });
    void qc.invalidateQueries({ queryKey: ["notifications-unread"] });
  };

  return (
    <Popover
      label="Notifications"
      width={370}
      trigger={({ open, toggle, ref }) => (
        <button
          ref={ref}
          className="pv-btn pv-btn-ghost pv-btn-icon"
          style={{ position: "relative" }}
          aria-label={`Notifications${count ? ` (${count} unread)` : ""}`}
          aria-expanded={open}
          onClick={() => {
            if (!open) refresh();
            toggle();
          }}
        >
          <Bell size={15} aria-hidden="true" />
          {count > 0 && (
            <span className={`pv-btn-badge${unreadThreat ? "" : " pv-btn-badge-info"}`}>
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      )}
    >
      {() => (
        <>
          <div className="pv-notify-head">
            <span className="pv-notify-title">Notifications</span>
            {count > 0 && (
              <>
                <button
                  className="pv-btn pv-btn-link pv-notify-action"
                  aria-pressed={unreadOnly}
                  onClick={() => setUnreadOnly((v) => !v)}
                >
                  {unreadOnly ? "Show all" : "Unread only"}
                </button>
                <button
                  className="pv-btn pv-btn-link pv-notify-action"
                  onClick={() => void markRead(undefined, true)}
                >
                  <CheckCheck size={12} aria-hidden="true" /> Mark all read
                </button>
              </>
            )}
          </div>
          <div className="pv-notify-list">
            {rows.map((n) => {
              const content = (
                <>
                  <KindIcon kind={n.kind} />
                  <span className="pv-notify-main">
                    <span className={`pv-notify-row-title${n.readAt ? "" : " pv-notify-unread"}`}>{n.title}</span>
                    {n.body && <span className="pv-notify-row-body">{n.body}</span>}
                    <span className="pv-notify-meta">
                      <span className={`pv-notify-kind pv-notify-kind-${notificationTone(n.kind)}`}>
                        {notificationKindLabel(n.kind)}
                      </span>
                      <span>{fmtRelative(n.createdAt)}</span>
                    </span>
                  </span>
                </>
              );
              return (
                <div key={n.id} className={`pv-notify-row${n.readAt ? "" : " pv-notify-row-unread"}`}>
                  {/* The row body is the link (a 12px "Open" caption is not a
                      target); the mark-read control stays a sibling so no
                      button is ever nested inside an anchor. */}
                  {n.link ? (
                    <Link
                      to={n.link}
                      className="pv-notify-link"
                      aria-label={`Open: ${n.title}`}
                      onClick={() => void markRead([n.id])}
                    >
                      {content}
                    </Link>
                  ) : (
                    <span className="pv-notify-link">{content}</span>
                  )}
                  {!n.readAt && (
                    <button
                      className="pv-btn pv-btn-ghost pv-btn-icon pv-btn-sm pv-notify-check"
                      aria-label={`Mark “${n.title}” read`}
                      title="Mark read"
                      onClick={() => void markRead([n.id])}
                    >
                      <Check size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
            {!rows.length && (
              <div className="pv-notify-empty">
                {unreadOnly ? (
                  <>
                    No unread notifications.
                    <button className="pv-btn pv-btn-link" style={{ marginLeft: 6 }} onClick={() => setUnreadOnly(false)}>
                      Show all
                    </button>
                  </>
                ) : (
                  "All caught up."
                )}
              </div>
            )}
          </div>
        </>
      )}
    </Popover>
  );
}
