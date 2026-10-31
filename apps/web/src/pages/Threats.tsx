import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { fmtDateTime } from "../lib/format.js";
import {
  PageHeader, EmptyState, Badge, Select, TableSkeleton, Alert, SearchInput, type BadgeTone,
} from "../ui/index.js";
import { matchesThreat, sortThreats, urgentCounts, type Severity } from "../lib/triage.js";

interface ThreatFinding {
  id: string;
  category: string;
  severity: Severity;
  title: string;
  summary: string;
  actorUsername: string | null;
  ip: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  events: string[];
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
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

/**
 * Deep link into the raw audit trail for the actor/IP behind a finding.
 * This is the triage step that used to be manual copy-paste: detection
 * says what happened, the audit log says exactly which events.
 */
function auditHref(f: ThreatFinding): string {
  const params = new URLSearchParams({ tab: "audit" });
  if (f.actorUsername) params.set("actor", f.actorUsername);
  if (f.ip) params.set("ip", f.ip);
  return `/system?${params.toString()}`;
}

/** What a reviewer can do about the finding, in one sentence. */
const NEXT_STEP: Record<string, string> = {
  "brute-force": "Check the source IP in the audit log, then lock or reset the targeted account.",
  privilege: "Confirm the role change was requested; revert it in Users if it was not.",
  secrets: "Reveal activity is audited — confirm the operator and rotate the credential if it looks wrong.",
  anomaly: "Compare the event against the schedule/session that should have caused it.",
  infra: "Verify the Proxmox node is healthy before assuming the change was malicious.",
};

/** Threat detection: risk indicators recomputed from audit events. */
export default function Threats() {
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState("");
  const [days, setDays] = useState(7);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"severity" | "recent">("severity");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { data, isFetching, isLoading } = useQuery({
    queryKey: ["threats", days],
    queryFn: () =>
      api<{ findings: ThreatFinding[]; evaluatedAt: string; eventsScanned: number; liveChecked: boolean }>(
        `/threats?days=${days}`,
      ),
    refetchInterval: 60000,
  });

  const all = data?.findings ?? [];
  const counts = new Map<string, number>();
  for (const f of all) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const urgent = urgentCounts(all);

  const findings = useMemo(
    () =>
      sortThreats(
        (data?.findings ?? []).filter(
          (f) =>
            (!category || f.category === category) &&
            (!severity || f.severity === severity) &&
            matchesThreat(f, search),
        ),
        sort,
      ),
    [data?.findings, category, severity, search, sort],
  );

  const filtered = findings.length !== all.length;

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearFilters = () => {
    setCategory("");
    setSeverity("");
    setSearch("");
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
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search actor, IP, or finding"
              label="Search findings"
            />
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
              value={sort}
              onChange={(e) => setSort(e.target.value === "recent" ? "recent" : "severity")}
              aria-label="Sort findings"
              title="Sort order"
            >
              <option value="severity">Most severe first</option>
              <option value="recent">Most recent first</option>
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
            {(category || severity || search) && (
              <button type="button" className="pv-btn pv-btn-sm pv-btn-ghost" onClick={clearFilters}>
                Clear filters
              </button>
            )}
            {isFetching && <span className="pv-faint" style={{ fontSize: "0.76rem" }}>Refreshing…</span>}
          </>
        }
      />

      {/* Triage banner: the one thing to do first, instead of scanning a table. */}
      {urgent.critical > 0 ? (
        <Alert
          kind="err"
          title={`${urgent.critical} critical finding${urgent.critical === 1 ? "" : "s"} — review now`}
          actions={
            <Link className="pv-btn pv-btn-sm" to="/system?tab=audit">
              Open audit log
            </Link>
          }
        >
          {urgent.high > 0
            ? `Plus ${urgent.high} high-severity finding${urgent.high === 1 ? "" : "s"}. Start with the top row, then confirm the actor and IP in the audit trail.`
            : "Start with the top row, then confirm the actor and IP in the audit trail."}
        </Alert>
      ) : urgent.high > 0 ? (
        <Alert
          kind="warn"
          title={`${urgent.high} high-severity finding${urgent.high === 1 ? "" : "s"}`}
          actions={
            <Link className="pv-btn pv-btn-sm" to="/system?tab=audit">
              Open audit log
            </Link>
          }
        >
          Nothing critical in this window. Check the actor and source IP before marking these as expected.
        </Alert>
      ) : data && all.length > 0 ? (
        <Alert kind="ok" title="No urgent findings">
          Nothing critical or high in this window. Lower-severity findings are still listed below.
        </Alert>
      ) : null}

      {/* An unreachable Proxmox API silently skips the live rule; say so. */}
      {data && !data.liveChecked && (
        <Alert kind="info" title="Live Proxmox check skipped">
          The Proxmox API did not answer, so out-of-band power changes were not compared this run. Audit-based
          findings above are unaffected.
        </Alert>
      )}

      <div className="pv-seg" role="group" aria-label="Severity filter" style={{ marginBottom: 14 }}>
        {chip("", "All", all.length)}
        {SEVERITY_ORDER.map((s) => chip(s, s.toUpperCase(), counts.get(s) ?? 0))}
      </div>

      {isLoading && !data ? (
        <div className="pv-table-wrap"><TableSkeleton rows={5} cols={8} /></div>
      ) : findings.length === 0 ? (
        <EmptyState
          title={all.length ? "No findings match these filters" : "No threats detected"}
          body={
            all.length
              ? "Clear the filters to see every finding in this window."
              : "Nothing in the window matches a detection rule. Check back — this page recomputes every minute."
          }
          action={
            filtered ? (
              <button type="button" className="pv-btn pv-btn-sm" onClick={clearFilters}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          {filtered && (
            <p className="pv-faint" style={{ fontSize: "0.78rem", margin: "0 0 8px" }}>
              Showing {findings.length} of {all.length} findings
            </p>
          )}
          <div className="pv-table-wrap">
            <table className="pv-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th className="pv-hide-sm">Category</th>
                  <th>Finding</th>
                  <th className="pv-hide-sm">Actor</th>
                  <th className="pv-hide-md">IP</th>
                  <th>Events</th>
                  <th className="pv-hide-sm">Last seen</th>
                  <th><span className="pv-sr-only">Actions</span></th>
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
                      <td className="pv-hide-sm" style={{ color: "var(--pv-text-2)" }}>
                        {CATEGORY_LABELS[f.category] ?? f.category}
                      </td>
                      <td style={{ fontWeight: 600 }}>{f.title}</td>
                      <td className="pv-mono pv-hide-sm">{f.actorUsername ?? "—"}</td>
                      <td className="pv-mono pv-faint pv-hide-md">{f.ip ?? "—"}</td>
                      <td className="pv-mono pv-faint">{f.count}</td>
                      <td className="pv-faint pv-hide-sm" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(f.lastSeen)}</td>
                      <td
                        onClick={(e) => e.stopPropagation()}
                        style={{ textAlign: "right", whiteSpace: "nowrap" }}
                      >
                        <Link
                          className="pv-btn pv-btn-sm pv-btn-link"
                          to={auditHref(f)}
                          title={
                            f.actorUsername || f.ip
                              ? `Show ${[f.actorUsername, f.ip].filter(Boolean).join(" · ")} in the audit log`
                              : "Open the audit log"
                          }
                        >
                          Audit
                        </Link>
                        <span style={{ color: "var(--pv-text-3)", fontSize: "0.72rem", marginLeft: 6 }}>
                          {open ? "▾" : "▸"}
                        </span>
                      </td>
                    </tr>,
                    open && (
                      <tr key={`${f.id}-detail`}>
                        <td
                          colSpan={8}
                          style={{
                            color: "var(--pv-text-2)",
                            fontSize: "0.85rem",
                            whiteSpace: "normal",
                            background: "var(--pv-inset)",
                          }}
                        >
                          {f.summary}
                          <div style={{ marginTop: 6, color: "var(--pv-text-2)" }}>
                            <strong style={{ fontWeight: 600 }}>Next step:</strong>{" "}
                            {NEXT_STEP[f.category] ?? "Confirm the event was expected before acting on it."}
                          </div>
                          <span
                            className="pv-mono"
                            style={{ display: "block", marginTop: 5, color: "var(--pv-text-3)", fontSize: "0.75rem" }}
                          >
                            sources: {f.events.join(", ") || "live state"} · first seen {fmtDateTime(f.firstSeen)} ·{" "}
                            <Link to={auditHref(f)}>trace in audit log →</Link>
                          </span>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
