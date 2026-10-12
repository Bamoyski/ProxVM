import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, StatusBadge, Empty, Section } from "../components/ui.js";

interface Check {
  name: string;
  status: "ONLINE" | "OFFLINE" | "ERROR";
  latencyMs: number | null;
  lastChecked: string;
  detail: string | null;
}

export default function Health() {
  const { data } = useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ healthy: boolean; checks: Check[] }>("/health"),
    refetchInterval: 15000,
  });

  return (
    <div className="pv-page pv-page-narrow">
      <PageTitle
        title="Health"
        description={data ? (data.healthy ? "All subsystems responding." : "One or more subsystems need attention.") : "Running checks…"}
      />
      <Section title="Subsystems">
        {(data?.checks ?? []).map((c) => (
          <div key={c.name} style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "9px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
            <span className="pv-mono" style={{ minWidth: 140 }}>{c.name}</span>
            <StatusBadge status={c.status} />
            <span style={{ marginLeft: "auto", color: "var(--pv-text-3)", fontVariantNumeric: "tabular-nums" }}>
              {c.latencyMs !== null ? `${c.latencyMs} ms` : "—"} · {new Date(c.lastChecked).toLocaleTimeString()}
            </span>
          </div>
        ))}
        {(data?.checks ?? []).filter((c) => c.detail).map((c) => (
          <div key={c.name} className="pv-error" style={{ marginBottom: 8, marginTop: 12 }}>
            <span className="pv-mono">{c.name}</span>: {c.detail}
          </div>
        ))}
        {!data && <Empty title="Running checks…" />}
      </Section>
    </div>
  );
}
