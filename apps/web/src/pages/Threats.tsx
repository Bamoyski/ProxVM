import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { fmtDateTime } from "../lib/format.js";
import { PageHeader, EmptyState, Badge, Select, TableSkeleton, type BadgeTone } from "../ui/index.js";

interface ThreatFinding {
  id: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  summary: string;
  actorUsername: string | null;
  ip: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  events: string[];
}

const SEVERITY_ORDER: ThreatFinding["severity"][] = ["critical", "high", "medium", "low"];

const SEVERITY_TONE: Record<ThreatFinding["severity"], BadgeTone> = {
  critical: "err",
  high: "warn",
  medium: "info",
  low: "neutral",
};

const CATEGORY_LABELS: Record<string, string> = {
  "brute-force": "Brute force",
  privilege: "Privilege",
  secrets: "Secrets",
  anomaly: "Anomaly",
  infra: "Infrastructure",
};

/** Threat detection: risk indicators recomputed from audit events. */
export default function Threats() {
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState("");
  const [days, setDays] = useState(7);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { data, isFetching, isLoading } = useQuery({
    queryKey: ["threats", days],
    queryFn: () => api<{ findings: ThreatFinding[]; evaluatedAt: string; eventsScanned: number }>(`/threats?days=${days}`),
    refetchInterval: 60000,
  });

  const all = data?.findings ?? [];
  const counts = new Map<string, number>();
  for (const f of all) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const findings = all.filter((f) => (!category || f.category === category) && (!severity || f.severity === severity));

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const chip = (value: string, label: string, count: number) => (
    <button
      key={value || "all"}
      type="button"
      onClick={() => setSeverity(value)}
      className={`pv-seg-btn${severity === value ? " pv-seg-btn-active" : ""}`}
      aria-pressed={severity === value}
      title={value ? `Show only ${label} findings` : "Show all severities"}
    >
      {label} ({count})
    </button>
  );

  return (
    <div className="pv-page">
      <PageHeader
        title="Threat detection"
        description={`Risk indicators recomputed from the last ${days} day(s) of audit events (${data?.eventsScanned ?? 0} scanned). Point-in-time — not stored, nothing to dismiss.`}
        actions={
          <>
            <Select
              autoWidth
              small
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="Category filter"
            >
              <option value="">All categories</option>
              {Object.entries(CATEGORY_LABELS).map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </Select>
            <Select
              autoWidth
              small
              value={String(days)}
              onChange={(e) => setDays(Number(e.target.value))}
              aria-label="Lookback window"
            >
              {[1, 7, 30].map((n) => (
                <option key={n} value={n}>{n} day{n === 1 ? "" : "s"}</option>
              ))}
            </Select>
            {isFetching && <span className="pv-faint" style={{ fontSize: "0.76rem" }}>Refreshing…</span>}
          </>
        }
      />

      <div className="pv-seg" role="group" aria-label="Severity filter" style={{ marginBottom: 14 }}>
        {chip("", "All", all.length)}
        {SEVERITY_ORDER.map((s) => chip(s, s.toUpperCase(), counts.get(s) ?? 0))}
      </div>

      {isLoading && !data ? (
        <div className="pv-table-wrap"><TableSkeleton rows={5} cols={7} /></div>
      ) : findings.length === 0 ? (
        <EmptyState
          title="No threats detected"
          body="Nothing in the window matches a detection rule. Check back — this page recomputes every minute."
        />
      ) : (
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Category</th>
                <th>Finding</th>
                <th className="pv-hide-sm">Actor</th>
                <th className="pv-hide-md">IP</th>
                <th>Events</th>
                <th className="pv-hide-sm">Last seen</th>
                <th><span className="pv-sr-only">Expand</span></th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => {
                const open = expanded.has(f.id);
                return [
                  <tr
                    key={f.id}
                    onClick={() => toggle(f.id)}
                    style={{ cursor: "pointer" }}
                    title="Click to expand"
                    aria-expanded={open}
                  >
                    <td>
                      <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity.toUpperCase()}</Badge>
                    </td>
                    <td style={{ color: "var(--pv-text-2)" }}>{CATEGORY_LABELS[f.category] ?? f.category}</td>
                    <td style={{ fontWeight: 600 }}>{f.title}</td>
                    <td className="pv-mono pv-hide-sm">{f.actorUsername ?? "—"}</td>
                    <td className="pv-mono pv-faint pv-hide-md">{f.ip ?? "—"}</td>
                    <td className="pv-mono pv-faint">{f.count}</td>
                    <td className="pv-faint pv-hide-sm" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(f.lastSeen)}</td>
                    <td style={{ color: "var(--pv-text-3)", fontSize: "0.72rem" }}>{open ? "▾" : "▸"}</td>
                  </tr>,
                  open && (
                    <tr key={`${f.id}-detail`}>
                      <td colSpan={8} style={{ color: "var(--pv-text-2)", fontSize: "0.85rem", whiteSpace: "normal", background: "var(--pv-inset)" }}>
                        {f.summary}
                        <span className="pv-mono" style={{ display: "block", marginTop: 5, color: "var(--pv-text-3)", fontSize: "0.75rem" }}>
                          sources: {f.events.join(", ") || "live state"} · first seen {fmtDateTime(f.firstSeen)}
                        </span>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
