import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bell, Check, CheckCheck } from "lucide-react";
import { api } from "../api.js";
import { Popover } from "../ui/index.js";
import { fmtRelative } from "../lib/format.js";

interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/** Global notifications (job outcomes, admin queue). Server-scoped rows. */
export default function NotificationBell() {
  const qc = useQueryClient();
  const { data: countData } = useQuery({
    queryKey: ["notifications-unread"],
    queryFn: () => api<{ count: number }>("/notifications/unread-count"),
    refetchInterval: 30000,
    retry: false,
  });
  const { data: listData } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<{ notifications: Notification[] }>("/notifications?limit=10"),
    retry: false,
  });

  const count = countData?.count ?? 0;
  const items = listData?.notifications ?? [];

  const markRead = async (ids?: string[], all?: boolean) => {
    try {
      await api("/notifications/read", { method: "POST", body: ids ? { ids } : { all: !!all } });
      void qc.invalidateQueries({ queryKey: ["notifications"] });
      void qc.invalidateQueries({ queryKey: ["notifications-unread"] });
    } catch {
      // read-marking is best-effort; the list stays usable
    }
  };

  return (
    <Popover
      label="Notifications"
      width={340}
      trigger={({ open, toggle, ref }) => (
        <button
          ref={ref}
          className="pv-btn pv-btn-ghost pv-btn-icon"
          style={{ position: "relative" }}
          aria-label={`Notifications${count ? ` (${count} unread)` : ""}`}
          aria-expanded={open}
          onClick={toggle}
        >
          <Bell size={15} aria-hidden="true" />
          {count > 0 && <span className="pv-btn-badge">{count > 99 ? "99+" : count}</span>}
        </button>
      )}
    >
      {() => (
        <>
          <div style={{ display: "flex", alignItems: "center", padding: "6px 10px 8px", borderBottom: "1px solid var(--pv-border-soft)" }}>
            <span style={{ fontWeight: 650, fontSize: "0.85rem" }}>Notifications</span>
            {count > 0 && (
              <button
                className="pv-btn pv-btn-link"
                style={{ marginLeft: "auto", fontSize: "0.76rem" }}
                onClick={() => void markRead(undefined, true)}
              >
                <CheckCheck size={12} aria-hidden="true" /> Mark all read
              </button>
            )}
          </div>
          <div style={{ maxHeight: 340, overflowY: "auto" }}>
            {items.map((n) => (
              <div
                key={n.id}
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "9px 10px",
                  borderBottom: "1px solid var(--pv-border-soft)",
                  background: n.readAt ? "transparent" : "var(--pv-accent-soft)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "0.82rem", fontWeight: n.readAt ? 500 : 650 }}>{n.title}</div>
                  {n.body && (
                    <div style={{ fontSize: "0.76rem", color: "var(--pv-text-2)", marginTop: 1 }}>{n.body}</div>
                  )}
                  <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 3 }}>
                    <span style={{ fontSize: "0.7rem", color: "var(--pv-text-3)" }}>{fmtRelative(n.createdAt)}</span>
                    {n.link && (
                      <Link
                        to={n.link}
                        style={{ fontSize: "0.72rem" }}
                        onClick={() => void markRead([n.id])}
                      >
                        Open
                      </Link>
                    )}
                  </div>
                </div>
                {!n.readAt && (
                  <button
                    className="pv-btn pv-btn-ghost pv-btn-icon pv-btn-sm"
                    aria-label={`Mark “${n.title}” read`}
                    title="Mark read"
                    onClick={() => void markRead([n.id])}
                  >
                    <Check size={12} aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
            {!items.length && (
              <div style={{ padding: "18px 12px", fontSize: "0.82rem", color: "var(--pv-text-3)", textAlign: "center" }}>
                All caught up.
              </div>
            )}
          </div>
        </>
      )}
    </Popover>
  );
}
