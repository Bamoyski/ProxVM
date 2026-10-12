import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, Empty, Btn } from "../components/ui.js";
import { AUDIT_EVENTS } from "@proxvm/shared";

// Filter vocabulary comes straight from the shared event list so new backend
// events (access grants, launches, template changes, ...) are filterable
// without a frontend change.
const EVENT_TYPES = ["", ...AUDIT_EVENTS];

export default function Audit() {
  const [event, setEvent] = useState("");
  const [ip, setIp] = useState("");
  const [actor, setActor] = useState("");
  const [limit, setLimit] = useState(100);
  const extra = `${ip ? `&ip=${encodeURIComponent(ip.trim())}` : ""}${actor ? `&actor=${encodeURIComponent(actor.trim())}` : ""}`;
  const { data, isFetching } = useQuery({
    queryKey: ["audit", event, limit, ip, actor],
    queryFn: () => api<{ entries: Array<Record<string, unknown>> }>(`/audit?limit=${limit}${event ? `&event=${event}` : ""}${extra}`),
    refetchInterval: 15000,
  });

  const exportHref = `/api/audit/export?limit=${Math.min(5000, Math.max(limit, 100))}${event ? `&event=${encodeURIComponent(event)}` : ""}${extra}`;
  const exportAllHref = `/api/audit/export?limit=50000${event ? `&event=${encodeURIComponent(event)}` : ""}${extra}`;

  return (
    <div className="pv-page">
      <PageTitle title="Audit log" description="Every privileged action, who did it, and when.">
        <select className="pv-select pv-input-auto" style={{ height: 32, fontSize: "0.8rem" }} value={event} onChange={(e) => setEvent(e.target.value)} aria-label="Event filter">
          {EVENT_TYPES.map((e) => (
            <option key={e} value={e}>{e || "All events"}</option>
          ))}
        </select>
        <input
          className="pv-input pv-input-auto"
          style={{ height: 32, fontSize: "0.8rem", width: 130 }}
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="Filter IP"
          aria-label="Filter by IP"
        />
        <input
          className="pv-input pv-input-auto"
          style={{ height: 32, fontSize: "0.8rem", width: 130 }}
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="Filter actor"
          aria-label="Filter by actor username"
        />
        <select className="pv-select pv-input-auto" style={{ height: 32, fontSize: "0.8rem" }} value={limit} onChange={(e) => setLimit(Number(e.target.value))} title="Rows shown" aria-label="Rows shown">
          {[50, 100, 200].map((n) => (
            <option key={n} value={n}>{n} rows</option>
          ))}
        </select>
        <a href={exportHref} className="pv-btn pv-btn-sm" title="Download the current filter as CSV">
          Export CSV
        </a>
        <a href={exportAllHref} className="pv-btn pv-btn-sm" title="Download up to 50,000 entries for the current filter as CSV">
          Export all
        </a>
        {isFetching && <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)" }}>Refreshing…</span>}
      </PageTitle>
      <div className="pv-table-wrap">
        <table className="pv-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>Actor</th>
              <th>IP</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {(data?.entries ?? []).map((e) => (
              <tr key={String(e.id)}>
                <td style={{ color: "var(--pv-text-2)", whiteSpace: "nowrap" }}>{new Date(String(e.createdAt)).toLocaleString()}</td>
                <td className="pv-mono">{String(e.event)}</td>
                <td>{String(e.actorUsername ?? "system")}</td>
                <td className="pv-mono" style={{ color: "var(--pv-text-3)" }}>{String(e.ip ?? "—")}</td>
                <td className="pv-mono" style={{ color: "var(--pv-text-2)", maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.detail ? JSON.stringify(e.detail) : undefined}>{e.detail ? JSON.stringify(e.detail) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data?.entries.length && <Empty title="No audit events" body="Privileged actions will appear here as they happen." />}
    </div>
  );
}
