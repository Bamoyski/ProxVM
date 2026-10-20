import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageHeader, Section, EmptyState, Alert, Stat, Meter, utilTone, errText } from "../ui/index.js";

interface UsageRow {
  vmId: string;
  vmName: string;
  hours: number;
}

interface DailyRow {
  day: string;
  hours: number;
}

/** Vertical bar chart of one value per day. Pure SVG, no dependencies;
 *  x labels thinned to every 5th day plus the last so they never collide. */
function DailyBars({ days }: { days: DailyRow[] }) {
  const w = 640;
  const h = 140;
  const pad = 4;
  const max = Math.max(...days.map((d) => d.hours), 0);
  if (!days.length) return <EmptyState title="No days in this month" />;
  const bw = (w - pad * 2) / days.length;
  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        style={{ width: "100%", height: 140, background: "var(--pv-inset)", border: "1px solid var(--pv-border-soft)", borderRadius: 6 }}
        role="img"
        aria-label={`Powered-on VM hours per day. Peak day ${max.toFixed(2)} hours.`}
      >
        {days.map((d, i) => {
          const bh = max > 0 ? Math.max(1.5, (d.hours / max) * (h - 28)) : 0;
          const x = pad + i * bw + 1;
          return (
            <g key={d.day}>
              <rect x={x} y={h - 20 - bh} width={Math.max(1, bw - 2)} height={bh} fill="var(--pv-accent, #3aa0ff)">
                <title>{`${d.day}: ${d.hours.toFixed(2)} h`}</title>
              </rect>
              {(i % 5 === 0 || i === days.length - 1) && (
                <text x={x} y={h - 6} fontSize="9" fill="var(--pv-text-3)">{d.day.slice(8)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="pv-faint" style={{ fontSize: "0.78rem", marginTop: 5 }}>
        Peak day: {max.toFixed(2)} h
      </div>
    </div>
  );
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function Usage() {
  const [month, setMonth] = useState(currentMonth());
  const { data, error } = useQuery({
    queryKey: ["usage", month],
    queryFn: () =>
      api<{ month: string; totalHours: number; vms: UsageRow[] }>(
        `/usage/summary?month=${encodeURIComponent(month)}`,
      ),
    retry: false,
  });
  const { data: daily } = useQuery({
    queryKey: ["usage-daily", month],
    queryFn: () =>
      api<{ month: string; days: DailyRow[] }>(
        `/usage/daily?month=${encodeURIComponent(month)}`,
      ).catch(() => ({ month, days: [] as DailyRow[] })),
    retry: false,
  });

  return (
    <div className="pv-page pv-page-narrow">
      <PageHeader
        title="Usage metering"
        description="Powered-on hours per VM, reconciled from the live Proxmox power state every few minutes — including machines switched on outside ProxVM. The basis for per-customer billing; export to CSV for invoicing."
        actions={
          <>
            <input
              type="month"
              className="pv-input pv-input-auto"
              style={{ height: 30, fontSize: "0.8rem" }}
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              aria-label="Month"
            />
            <a className="pv-btn pv-btn-sm" href={`/api/usage/export?month=${encodeURIComponent(month)}`}>
              Export CSV
            </a>
          </>
        }
      />
      {error && <Alert kind="err" title="Failed to load usage">{errText(error)}</Alert>}

      {data && (
        <div className="pv-grid-stats" style={{ marginBottom: 20 }}>
          <Stat label={`Total, ${data.month}`} value={`${data.totalHours.toFixed(2)} h`} />
          <Stat label="Metered VMs" value={String(data.vms.length)} />
        </div>
      )}

      <Section title="Daily fleet activity" hint="Powered-on hours summed across the fleet, per day.">
        <DailyBars days={daily?.days ?? []} />
      </Section>

      <Section title="Per VM" hint="Share of the month's total — the billing split.">
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>
                <th>VM</th>
                <th className="num">Powered-on hours</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {(data?.vms ?? []).map((r) => {
                const share = data && data.totalHours > 0 ? (r.hours / data.totalHours) * 100 : 0;
                return (
                  <tr key={r.vmId}>
                    <td>{r.vmName}</td>
                    <td className="num pv-mono">{r.hours.toFixed(2)}</td>
                    <td style={{ minWidth: 180 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <Meter value={share} max={100} tone={utilTone(share)} title={`${r.vmName}: ${share.toFixed(1)}% of total`} />
                        </div>
                        <span className="pv-mono" style={{ fontSize: "0.78rem", color: "var(--pv-text-2)" }}>{share.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data && data.vms.length === 0 && (
          <EmptyState title="No metered time this month yet" body="Powered-on hours appear within a few minutes of the VM running." />
        )}
      </Section>
    </div>
  );
}
