import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox, Section, Empty } from "../components/ui.js";

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
    <div className="pv-page pv-page-narrow">
      <PageTitle
        title="Usage metering"
        description="Powered-on hours per VM, reconciled from the live Proxmox power state every few minutes — including machines switched on outside ProxVM. The basis for per-customer billing; export to CSV for invoicing."
      >
        <input
          type="month"
          className="pv-input pv-input-auto"
          style={{ height: 32, fontSize: "0.8rem" }}
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            setError(null);
          }}
          aria-label="Month"
        />
        <a
          className="pv-btn pv-btn-sm"
          href={`/api/usage/export?month=${encodeURIComponent(month)}`}
        >
          Export CSV
        </a>
      </PageTitle>
      {error && <ErrorBox error={error} />}
      {data && (
        <dl style={{ display: "flex", gap: 28, margin: "0 0 20px" }}>
          <div>
            <dt style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--pv-text-3)" }}>Total, {data.month}</dt>
            <dd className="pv-mono" style={{ margin: 0, fontSize: "1.5rem", fontWeight: 650 }}>{data.totalHours.toFixed(2)} h</dd>
          </div>
        </dl>
      )}
      <Section title="Per VM">
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>
                <th>VM</th>
                <th className="num">Powered-on hours</th>
              </tr>
            </thead>
            <tbody>
              {(data?.vms ?? []).map((r) => (
                <tr key={r.vmId}>
                  <td>{r.vmName}</td>
                  <td className="num pv-mono">{r.hours.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.vms.length === 0 && (
          <Empty title="No metered time this month yet" />
        )}
      </Section>
    </div>
  );
}
