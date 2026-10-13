import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox, Section, Empty } from "../components/ui.js";

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
  if (!days.length) return <Empty title="No days in this month" />;
  const bw = (w - pad * 2) / days.length;
  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        style={{ width: "100%", height: 140, background: "var(--pv-inset)", border: "1px solid var(--pv-border-soft)", borderRadius: 6 }}
        role="img"
        aria-label="Powered-on VM hours per day"
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
      <div style={{ fontSize: "0.78rem", color: "var(--pv-text-3)", marginTop: 4 }}>
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
      <Section title="Daily fleet activity">
        <DailyBars days={daily?.days ?? []} />
      </Section>
      <Section title="Per VM">
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
                    <td style={{ minWidth: 140 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, height: 8, background: "var(--pv-inset)", borderRadius: 4, overflow: "hidden" }}>
                          <div style={{ width: `${share.toFixed(1)}%`, height: "100%", background: "var(--pv-accent, #3aa0ff)" }} />
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
          <Empty title="No metered time this month yet" />
        )}
      </Section>
    </div>
  );
}
