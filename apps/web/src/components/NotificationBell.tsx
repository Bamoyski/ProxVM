import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api.js";

interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/** Topbar bell: server-side unread count, dropdown with mark-read. The
 *  server scopes rows (admin queue + own), so this renders for everyone
 *  and simply shows an empty state when there is nothing. */
export default function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: countData } = useQuery({
    queryKey: ["notifications-unread"],
    queryFn: () => api<{ count: number }>("/notifications/unread-count"),
    refetchInterval: 30000,
    retry: false,
  });
  const { data: listData } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<{ notifications: NotificationItem[] }>("/notifications?limit=10"),
    enabled: open,
    retry: false,
  });
  const unread = countData?.count ?? 0;

  const markRead = async (ids?: string[], all?: boolean) => {
    try {
      await api("/notifications/read", { method: "POST", body: { ids, all } });
      void qc.invalidateQueries({ queryKey: ["notifications-unread"] });
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    } catch {
      // read-state loss is cosmetic; the rows remain
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="pv-btn pv-btn-sm"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread ? `${unread} unread notifications` : "No unread notifications"}
        aria-expanded={open}
        title="Notifications"
      >
        <span aria-hidden="true">✉️</span>
        {unread > 0 && (
          <span
            className="pv-mono"
            style={{ marginLeft: 6, fontSize: "0.72rem", fontWeight: 700, color: "#fff", background: "#3aa0ff", padding: "1px 7px", borderRadius: 10 }}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className="pv-panel"
          style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 360, maxWidth: "calc(100vw - 32px)", zIndex: 60, padding: 8 }}
          role="dialog"
          aria-label="Notifications"
        >
          {(listData?.notifications ?? []).map((n) => (
            <div key={n.id} style={{ padding: "8px 10px", borderBottom: "1px solid var(--pv-border, #2a2f3a)", opacity: n.readAt ? 0.6 : 1 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
                <span className="pv-mono" style={{ fontSize: "0.68rem", fontWeight: 700, color: "var(--pv-text-2)" }}>
                  {n.kind.toUpperCase()}
                </span>
                <span className="pv-mono" style={{ fontSize: "0.7rem", color: "var(--pv-text-3)" }}>
                  {new Date(n.createdAt).toLocaleString()}
                </span>
                {!n.readAt && (
                  <button className="pv-btn pv-btn-link" style={{ fontSize: "0.7rem", marginLeft: "auto" }} onClick={() => void markRead([n.id])}>
                    Mark read
                  </button>
                )}
              </div>
              <div style={{ fontSize: "0.85rem", fontWeight: n.readAt ? 400 : 600 }}>{n.title}</div>
              {n.body && <div style={{ fontSize: "0.8rem", color: "var(--pv-text-2)" }}>{n.body}</div>}
              {n.link && (
                <Link to={n.link} onClick={() => { void markRead([n.id]); setOpen(false); }} style={{ fontSize: "0.78rem" }}>
                  Open →
                </Link>
              )}
            </div>
          ))}
          {!(listData?.notifications ?? []).length && (
            <div style={{ padding: "8px 10px", fontSize: "0.85rem", color: "var(--pv-text-2)" }}>
              All caught up — new tickets, requests, threats, and backup failures land here.
            </div>
          )}
          <button className="pv-btn pv-btn-sm" style={{ width: "100%", marginTop: 8 }} onClick={() => void markRead(undefined, true)}>
            Mark all read
          </button>
        </div>
      )}
    </div>
  );
}
