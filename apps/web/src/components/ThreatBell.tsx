import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api.js";

interface ThreatFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  actorUsername: string | null;
  ip: string | null;
  lastSeen: string;
}

const SEEN_KEY = "proxvm-threats-seen";

function loadSeen(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    // corrupted storage clears itself
  }
  return new Set();
}

/** Topbar bell: badge counts unseen high/critical findings from the last day. */
export default function ThreatBell() {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(loadSeen);
  const { data } = useQuery({
    queryKey: ["threat-bell"],
    queryFn: () => api<{ findings: ThreatFinding[] }>(`/threats?days=1`),
    refetchInterval: 60000,
  });

  const urgent = (data?.findings ?? []).filter((f) => f.severity === "critical" || f.severity === "high");
  const unseen = urgent.filter((f) => !seen.has(f.id));

  const markSeen = (ids: string[]) => {
    setSeen((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      try {
        window.localStorage.setItem(SEEN_KEY, JSON.stringify([...next].slice(-200)));
      } catch {
        // storage full or unavailable: badge just recomputes next poll
      }
      return next;
    });
  };

  const toggle = () => {
    if (!open) markSeen(urgent.map((f) => f.id));
    setOpen((v) => !v);
  };

  return (
    <div style={{ position: "relative", marginLeft: "auto" }}>
      <button
        type="button"
        className="pv-btn pv-btn-sm"
        onClick={toggle}
        aria-label={unseen.length ? `${unseen.length} unseen high-severity threat findings` : "No unseen threat findings"}
        aria-expanded={open}
        title="Threat alerts"
      >
        <span aria-hidden="true">🔔</span>
        {unseen.length > 0 && (
          <span
            className="pv-mono"
            style={{
              marginLeft: 6,
              fontSize: "0.72rem",
              fontWeight: 700,
              color: "#fff",
              background: urgent.some((f) => f.severity === "critical" && !seen.has(f.id)) ? "#ff5d5d" : "#ff9f43",
              padding: "1px 7px",
              borderRadius: 10,
            }}
          >
            {unseen.length}
          </span>
        )}
      </button>
      {open && (
        <div
          className="pv-panel"
          style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 340, maxWidth: "calc(100vw - 32px)", zIndex: 60, padding: 8 }}
          role="dialog"
          aria-label="Threat alerts"
        >
          {urgent.length === 0 ? (
            <div style={{ padding: "8px 10px", fontSize: "0.85rem", color: "var(--pv-text-2)" }}>
              No high or critical findings in the last day.
            </div>
          ) : (
            urgent.slice(0, 8).map((f) => (
              <div key={f.id} style={{ padding: "8px 10px", borderBottom: "1px solid var(--pv-border, #2a2f3a)" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
                  <span
                    className="pv-mono"
                    style={{ fontSize: "0.68rem", fontWeight: 700, color: f.severity === "critical" ? "#ff5d5d" : "#ff9f43" }}
                  >
                    {f.severity.toUpperCase()}
                  </span>
                  <span className="pv-mono" style={{ fontSize: "0.7rem", color: "var(--pv-text-3)" }}>
                    {new Date(f.lastSeen).toLocaleString()}
                  </span>
                </div>
                <div style={{ fontSize: "0.85rem" }}>{f.title}</div>
              </div>
            ))
          )}
          <Link to="/system?tab=threats" onClick={() => setOpen(false)} className="pv-btn pv-btn-sm" style={{ width: "100%", marginTop: 8, textAlign: "center" }}>
            Open threat detection
          </Link>
        </div>
      )}
    </div>
  );
}
