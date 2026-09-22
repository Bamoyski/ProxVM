import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle } from "../components/ui.js";
import { AUDIT_EVENTS } from "@proxvm/shared";

// Filter vocabulary comes straight from the shared event list so new backend
// events (access grants, launches, template changes, ...) are filterable
// without a frontend change.
const EVENT_TYPES = ["", ...AUDIT_EVENTS];

export default function Audit() {
  const [event, setEvent] = useState("");
  const [limit, setLimit] = useState(100);
  const { data, isFetching } = useQuery({
    queryKey: ["audit", event, limit],
    queryFn: () => api<{ entries: Array<Record<string, unknown>> }>(`/audit?limit=${limit}${event ? `&event=${event}` : ""}`),
    refetchInterval: 15000,
  });

  const input = "bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-xs";

  const exportHref = `/api/audit/export?limit=${Math.min(5000, Math.max(limit, 100))}${event ? `&event=${encodeURIComponent(event)}` : ""}`;

  return (
    <div>
      <PageTitle title="Audit Log">
        <select className={input} value={event} onChange={(e) => setEvent(e.target.value)}>
          {EVENT_TYPES.map((e) => (
            <option key={e} value={e}>{e || "All events"}</option>
          ))}
        </select>
        <select className={input} value={limit} onChange={(e) => setLimit(Number(e.target.value))} title="Rows shown">
          {[50, 100, 200].map((n) => (
            <option key={n} value={n}>{n} rows</option>
          ))}
        </select>
        <a href={exportHref} className="text-xs px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded" title="Download the current filter as CSV">
          Export CSV
        </a>
        {isFetching && <span className="text-xs text-slate-500">Refreshing…</span>}
      </PageTitle>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
              <th className="py-2">Time</th>
              <th className="py-2">Event</th>
              <th className="py-2">Actor</th>
              <th className="py-2">IP</th>
              <th className="py-2">Detail</th>
            </tr>
          </thead>
          <tbody>
            {(data?.entries ?? []).map((e) => (
              <tr key={String(e.id)} className="border-b border-slate-800/50 hover:bg-slate-900/50">
                <td className="py-2 text-xs text-slate-400 whitespace-nowrap">{new Date(String(e.createdAt)).toLocaleString()}</td>
                <td className="font-mono text-xs">{String(e.event)}</td>
                <td>{String(e.actorUsername ?? "system")}</td>
                <td className="font-mono text-xs text-slate-500">{String(e.ip ?? "—")}</td>
                <td className="font-mono text-xs text-slate-500 max-w-md truncate">{e.detail ? JSON.stringify(e.detail) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data?.entries.length && <div className="text-sm text-slate-500 py-4">No audit events.</div>}
      </div>
    </div>
  );
}
