import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox } from "../components/ui.js";

interface UsageRow {
  vmId: string;
  vmName: string;
  hours: number;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function Usage() {
  const [month, setMonth] = useState(currentMonth());
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["usage", month],
    queryFn: () =>
      api<{ month: string; totalHours: number; vms: UsageRow[] }>(
        `/usage/summary?month=${encodeURIComponent(month)}`,
      ).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }),
    retry: false,
  });

  return (
    <div className="max-w-4xl">
      <PageTitle title="Usage metering" />
      {error && <ErrorBox error={error} />}
      <p className="text-xs text-slate-500 mb-4">
        Powered-on hours per VM, reconciled from the live Proxmox power state every few minutes — including
        machines switched on outside ProxVM. The basis for per-customer billing; export to CSV for invoicing.
      </p>
      <div className="flex flex-wrap gap-2 items-center mb-4">
        <input
          type="month"
          className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm"
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            setError(null);
          }}
        />
        <a
          className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded"
          href={`/api/usage/export?month=${encodeURIComponent(month)}`}
        >
          Export CSV
        </a>
        {data && (
          <span className="text-sm text-slate-300 ml-auto">
            Total <span className="font-mono text-blue-300">{data.totalHours.toFixed(2)} h</span>
          </span>
        )}
      </div>
      <div className="bg-slate-900 border border-slate-800 rounded p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
              <th className="py-2">VM</th>
              <th className="py-2 text-right">Powered-on hours</th>
            </tr>
          </thead>
          <tbody>
            {(data?.vms ?? []).map((r) => (
              <tr key={r.vmId} className="border-b border-slate-800/50">
                <td className="py-2">{r.vmName}</td>
                <td className="py-2 text-right font-mono">{r.hours.toFixed(2)}</td>
              </tr>
            ))}
            {data && data.vms.length === 0 && (
              <tr>
                <td colSpan={2} className="py-4 text-center text-xs text-slate-500">
                  No metered time this month yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
