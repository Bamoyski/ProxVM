import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { AUDIT_EVENTS } from "@proxvm/shared";
import { fmtDateTime } from "../lib/format.js";
import { PageHeader, EmptyState, Select, Input, TableSkeleton, Btn, Alert } from "../ui/index.js";

// Filter vocabulary comes straight from the shared event list so new backend
// events (access grants, launches, template changes, ...) are filterable
// without a frontend change.
const EVENT_TYPES = ["", ...AUDIT_EVENTS];

/** Immutable audit trail viewer with server-side filtering + CSV export. */
export default function Audit() {
  const [event, setEvent] = useState("");
  const [ip, setIp] = useState("");
  const [actor, setActor] = useState("");
  const [limit, setLimit] = useState(100);
  const extra = `${ip ? `&ip=${encodeURIComponent(ip.trim())}` : ""}${actor ? `&actor=${encodeURIComponent(actor.trim())}` : ""}`;
  const { data, isFetching, isLoading } = useQuery({
    queryKey: ["audit", event, limit, ip, actor],
    queryFn: () => api<{ entries: Array<Record<string, unknown>> }>(`/audit?limit=${limit}${event ? `&event=${event}` : ""}${extra}`),
    refetchInterval: 15000,
  });

  const exportHref = `/api/audit/export?limit=${Math.min(5000, Math.max(limit, 100))}${event ? `&event=${encodeURIComponent(event)}` : ""}${extra}`;
  const exportAllHref = `/api/audit/export?limit=50000${event ? `&event=${encodeURIComponent(event)}` : ""}${extra}`;

  return (
    <div className="pv-page">
      <PageHeader title="Audit log" description="Every privileged action, who did it, and when." />

      <div className="pv-toolbar">
        <Select autoWidth small value={event} onChange={(e) => setEvent(e.target.value)} aria-label="Event filter">
          {EVENT_TYPES.map((e) => (
            <option key={e} value={e}>{e || "All events"}</option>
          ))}
        </Select>
        <Input
          small
          autoWidth
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="Filter IP"
          aria-label="Filter by IP"
        />
        <Input
          small
          autoWidth
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="Filter actor"
          aria-label="Filter by actor username"
        />
        <Select
          autoWidth
          small
          value={String(limit)}
          onChange={(e) => setLimit(Number(e.target.value))}
          title="Rows shown"
          aria-label="Rows shown"
        >
          {[50, 100, 200].map((n) => (
            <option key={n} value={n}>{n} rows</option>
          ))}
        </Select>
        <a href={exportHref} className="pv-btn pv-btn-sm" title="Download the current filter as CSV">
          Export CSV
        </a>
        <a href={exportAllHref} className="pv-btn pv-btn-sm" title="Download up to 50,000 entries for the current filter as CSV">
          Export all
        </a>
        {isFetching && <span className="pv-faint" style={{ fontSize: "0.76rem" }}>Refreshing…</span>}
        {(ip || actor || event) && (
          <Btn size="sm" kind="ghost" onClick={() => { setEvent(""); setIp(""); setActor(""); }}>
            Clear filters
          </Btn>
        )}
      </div>

      {isLoading && !data ? (
        <div className="pv-table-wrap"><TableSkeleton rows={8} cols={5} /></div>
      ) : (
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th className="pv-hide-sm">Actor</th>
                <th className="pv-hide-md">IP</th>
                <th className="pv-hide-md">Detail</th>
              </tr>
            </thead>
            <tbody>
              {(data?.entries ?? []).map((e) => (
                <tr key={String(e.id)}>
                  <td className="pv-faint" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(String(e.createdAt))}</td>
                  <td className="pv-mono">{String(e.event)}</td>
                  <td className="pv-hide-sm">{String(e.actorUsername ?? "system")}</td>
                  <td className="pv-mono pv-faint pv-hide-md">{String(e.ip ?? "—")}</td>
                  <td
                    className="pv-mono pv-faint pv-hide-md"
                    style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={e.detail ? JSON.stringify(e.detail) : undefined}
                  >
                    {e.detail ? JSON.stringify(e.detail) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && !data.entries.length && (
        <EmptyState title="No audit events" body="Privileged actions will appear here as they happen." />
      )}
      {data && data.entries.length >= limit && (
        <Alert kind="info" title={`Showing the newest ${limit} entries`}>
          Narrow the filter or raise the row limit — export for a complete archive.
        </Alert>
      )}
    </div>
  );
}
