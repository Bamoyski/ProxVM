import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { api } from "../api.js";
import { Popover } from "../ui/index.js";
import { fmtRelative } from "../lib/format.js";

interface Finding {
  id: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  detail?: string | null;
  lastSeen: string;
  eventCount?: number;
}

const SEEN_KEY = "proxvm-threats-seen";

function readSeen(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function writeSeen(ids: string[]): void {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-200)));
  } catch {
    // private mode: seen-state just won't persist
  }
}

/** Urgent-threat indicator (audit.read only): unseen critical/high findings. */
export default function ThreatBell() {
  const { data } = useQuery({
    queryKey: ["threat-bell"],
    queryFn: () => api<{ findings: Finding[] }>("/threats?days=1"),
    refetchInterval: 60000,
    retry: false,
  });

  const urgent = (data?.findings ?? []).filter((f) => f.severity === "critical" || f.severity === "high");
  const seen = new Set(readSeen());
  const unseenUrgent = urgent.filter((f) => !seen.has(f.id));
  const criticalUnseen = unseenUrgent.some((f) => f.severity === "critical");

  return (
    <Popover
      label="Threat feed"
      width={340}
      trigger={({ open, toggle, ref }) => (
        <button
          ref={ref}
          className="pv-btn pv-btn-ghost pv-btn-icon"
          style={{ position: "relative" }}
          aria-label={`Threats${unseenUrgent.length ? ` (${unseenUrgent.length} new urgent)` : ""}`}
          aria-expanded={open}
          onClick={() => {
            if (!open) {
              // Opening the feed marks urgent findings as seen.
              writeSeen([...seen, ...unseenUrgent.map((f) => f.id)]);
            }
            toggle();
          }}
        >
          <ShieldAlert size={15} aria-hidden="true" />
          {unseenUrgent.length > 0 && (
            <span
              className="pv-btn-badge"
              style={{ background: criticalUnseen ? "var(--pv-err-solid)" : "var(--pv-warn)" }}
            >
              {unseenUrgent.length > 9 ? "9+" : unseenUrgent.length}
            </span>
          )}
        </button>
      )}
    >
      {() => (
        <>
          <div style={{ padding: "6px 10px 8px", borderBottom: "1px solid var(--pv-border-soft)", fontWeight: 650, fontSize: "0.85rem" }}>
            Threats (last 24h)
          </div>
          <div style={{ maxHeight: 340, overflowY: "auto" }}>
            {urgent.slice(0, 8).map((f) => (
              <div key={f.id} style={{ padding: "9px 10px", borderBottom: "1px solid var(--pv-border-soft)" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span
                    className={`pv-badge ${f.severity === "critical" ? "pv-badge-err" : "pv-badge-warn"}`}
                  >
                    {f.severity}
                  </span>
                  <span style={{ fontSize: "0.82rem", fontWeight: 550, flex: 1, minWidth: 0 }}>{f.title}</span>
                </div>
                <div style={{ fontSize: "0.7rem", color: "var(--pv-text-3)", marginTop: 3 }}>
                  {fmtRelative(f.lastSeen)}
                </div>
              </div>
            ))}
            {!urgent.length && (
              <div style={{ padding: "18px 12px", fontSize: "0.82rem", color: "var(--pv-text-3)", textAlign: "center" }}>
                No urgent threats detected in the last 24 hours.
              </div>
            )}
          </div>
          <div style={{ padding: "8px 10px", borderTop: "1px solid var(--pv-border-soft)" }}>
            <Link to="/system?tab=threats" style={{ fontSize: "0.78rem" }}>
              Open threat analysis →
            </Link>
          </div>
        </>
      )}
    </Popover>
  );
}
