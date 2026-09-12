import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, StatusBadge } from "../components/ui.js";

interface Check {
  name: string;
  status: "ONLINE" | "OFFLINE" | "ERROR";
  latencyMs: number | null;
  lastChecked: string;
  detail: string | null;
}

export default function Health() {
  const { data, error, isFetching } = useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ healthy: boolean; checks: Check[] }>("/health"),
    refetchInterval: 15000,
  });

  return (
    <div>
      <PageTitle title="Health" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(data?.checks ?? []).map((c) => (
          <div key={c.name} className="bg-slate-900 border border-slate-800 rounded p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-sm">{c.name}</span>
              <StatusBadge status={c.status} />
            </div>
            <div className="text-xs text-slate-400">
              Latency: {c.latencyMs !== null ? `${c.latencyMs} ms` : "—"}
              <span className="mx-2">·</span>
              Last check: {new Date(c.lastChecked).toLocaleTimeString()}
            </div>
            {c.detail && <div className="text-xs text-red-300 mt-1">{c.detail}</div>}
          </div>
        ))}
      </div>
      {!data && <div className="text-sm text-slate-500">Running checks…</div>}
    </div>
  );
}