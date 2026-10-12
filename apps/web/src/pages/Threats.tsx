import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, Empty } from "../components/ui.js";

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

const SEVERITY_STYLE: Record<ThreatFinding["severity"], { color: string; bg: string }> = {
  critical: { color: "#ff5d5d", bg: "rgba(255,93,93,0.12)" },
  high: { color: "#ff9f43", bg: "rgba(255,159,67,0.12)" },
  medium: { color: "#e6c34a", bg: "rgba(230,195,74,0.12)" },
  low: { color: "#7fb3d5", bg: "rgba(127,179,213,0.12)" },
};

const CATEGORY_LABELS: Record<string, string> = {
  "brute-force": "Brute force",
  privilege: "Privilege",
  secrets: "Secrets",
  anomaly: "Anomaly",
  infra: "Infrastructure",
};

export default function Threats() {
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState("");
  const [days, setDays] = useState(7);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { data, isFetching } = useQuery({
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

  const chip = (value: string, label: string, count: number, activeColor?: string) => (
    <button
      key={value || "all"}
      type="button"
      onClick={() => setSeverity(value)}
      className="pv-btn pv-btn-sm"
      aria-pressed={severity === value}
      style={
        severity === value
          ? { borderColor: activeColor ?? "var(--pv-accent)", color: activeColor ?? "var(--pv-accent)" }
          : undefined
      }
      title={value ? `Show only ${label} findings` : "Show all severities"}
    >
      {label} ({count})
    </button>
  );

  return (
    <div className="pv-page">
      <PageTitle
        title="Threat detection"
        description={`Risk indicators recomputed from the last ${days} day(s) of audit events (${data?.eventsScanned ?? 0} scanned). Point-in-time — not stored, nothing to dismiss.`}
      >
        <select
          className="pv-select pv-input-auto"
          style={{ height: 32, fontSize: "0.8rem" }}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Category filter"
        >
          <option value="">All categories</option>
          {Object.entries(CATEGORY_LABELS).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
        <select
          className="pv-select pv-input-auto"
          style={{ height: 32, fontSize: "0.8rem" }}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Lookback window"
        >
          {[1, 7, 30].map((n) => (
            <option key={n} value={n}>{n} day{n === 1 ? "" : "s"}</option>
          ))}
        </select>
        {isFetching && <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)" }}>Refreshing…</span>}
      </PageTitle>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {chip("", "All", all.length)}
        {SEVERITY_ORDER.map((s) => chip(s, s.toUpperCase(), counts.get(s) ?? 0, SEVERITY_STYLE[s].color))}
      </div>
      {findings.length === 0 ? (
        <Empty title="No threats detected" body="Nothing in the window matches a detection rule. Check back — this page recomputes every minute." />
      ) : (
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Category</th>
                <th>Finding</th>
                <th>Actor</th>
                <th>IP</th>
                <th>Events</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => {
                const s = SEVERITY_STYLE[f.severity];
                const open = expanded.has(f.id);
                return [
                  <tr key={f.id} onClick={() => toggle(f.id)} style={{ cursor: "pointer" }} title="Click to expand">
                    <td>
                      <span
                        className="pv-mono"
                        style={{ fontSize: "0.72rem", fontWeight: 700, color: s.color, background: s.bg, padding: "2px 8px", borderRadius: 4 }}
                      >
                        {f.severity.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ color: "var(--pv-text-2)" }}>{CATEGORY_LABELS[f.category] ?? f.category}</td>
                    <td style={{ fontWeight: 600 }}>{f.title}</td>
                    <td className="pv-mono">{f.actorUsername ?? "—"}</td>
                    <td className="pv-mono" style={{ color: "var(--pv-text-3)" }}>{f.ip ?? "—"}</td>
                    <td className="pv-mono" style={{ color: "var(--pv-text-3)" }}>{f.count}</td>
                    <td style={{ color: "var(--pv-text-2)", whiteSpace: "nowrap" }}>{new Date(f.lastSeen).toLocaleString()}</td>
                  </tr>,
                  open && (
                    <tr key={`${f.id}-detail`}>
                      <td colSpan={7} style={{ color: "var(--pv-text-2)", fontSize: "0.85rem", whiteSpace: "normal" }}>
                        {f.summary}
                        <span className="pv-mono" style={{ display: "block", marginTop: 4, color: "var(--pv-text-3)", fontSize: "0.75rem" }}>
                          sources: {f.events.join(", ") || "live state"} · first seen {new Date(f.firstSeen).toLocaleString()}
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
