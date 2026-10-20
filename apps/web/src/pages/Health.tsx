import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, explainDenial } from "../api.js";
import { fmtClock } from "../lib/format.js";
import { PageHeader, StatusBadge, EmptyState, Section, Meter, utilTone, Badge } from "../ui/index.js";

interface Check {
  name: string;
  status: "ONLINE" | "OFFLINE" | "ERROR" | "UNCONFIGURED";
  latencyMs: number | null;
  lastChecked: string;
  detail: string | null;
}

interface NodeStatus {
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
}

/** Human labels + the page that can fix each service. Detail strings from the
 *  backend are deliberately URL/hostname-free, safe at every role level. */
const SERVICES: Record<string, { label: string; group: string; link: string | null; linkLabel?: string }> = {
  postgresql: { label: "PostgreSQL", group: "Core", link: null },
  redis: { label: "Redis", group: "Core", link: null },
  worker: { label: "Provisioning worker", group: "Core", link: "/automations?tab=schedules", linkLabel: "Jobs" },
  proxmox: { label: "Proxmox VE", group: "Integrations", link: "/vms", linkLabel: "VMs" },
  pbs: { label: "Proxmox Backup Server", group: "Integrations", link: "/configuration?tab=settings", linkLabel: "Settings" },
  gotify_push: { label: "Gotify notifications", group: "Integrations", link: "/configuration?tab=settings", linkLabel: "Settings" },
  cloudflare_tunnels: { label: "Cloudflare tunnels", group: "Integrations", link: "/configuration?tab=domains", linkLabel: "Domains" },
  guacamole_database: { label: "Guacamole database", group: "Remote access", link: "/guacamole", linkLabel: "Guacamole" },
  guacamole_web: { label: "Guacamole web app", group: "Remote access", link: "/guacamole", linkLabel: "Guacamole" },
};

const GROUPS = ["Core", "Integrations", "Remote access"];

/** Tile dot color: green up, red broken, muted not-configured. OFFLINE is a
 *  legacy status that never occurs from runHealthChecks; paint it amber. */
function dotColor(status: Check["status"]): string {
  if (status === "ONLINE") return "var(--pv-ok)";
  if (status === "ERROR" || status === "OFFLINE") return "var(--pv-err)";
  return "var(--pv-text-3)";
}

function statusWord(status: Check["status"]): string {
  if (status === "ONLINE") return "Operational";
  if (status === "ERROR" || status === "OFFLINE") return "Down";
  return "Not configured";
}

function Tile({ check }: { check: Check }) {
  const meta = SERVICES[check.name];
  const label = meta?.label ?? check.name;
  const color = dotColor(check.status);
  const failure = check.status === "ERROR" || check.status === "OFFLINE";
  return (
    <div
      className="pv-panel"
      style={{ padding: "12px 14px", borderLeft: `3px solid ${color}`, display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            flex: "none",
            background: color,
            boxShadow: failure ? `0 0 0 3px color-mix(in srgb, ${color} 25%, transparent)` : "none",
          }}
        />
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ marginLeft: "auto", fontSize: "0.78rem", color: failure ? "var(--pv-err)" : "var(--pv-text-3)" }}>
          {statusWord(check.status)}
        </span>
      </div>
      <div style={{ display: "flex", gap: 10, fontSize: "0.74rem", color: "var(--pv-text-3)", fontVariantNumeric: "tabular-nums" }}>
        <span>{check.latencyMs !== null ? `${check.latencyMs} ms` : "—"}</span>
        <span>checked {fmtClock(check.lastChecked)}</span>
      </div>
      {(check.detail || meta?.link) && (
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: "0.78rem" }}>
          {check.detail && <span style={{ color: failure ? "var(--pv-err)" : "var(--pv-text-2)", flex: 1 }}>{check.detail}</span>}
          {meta?.link && <Link to={meta.link} style={{ flex: "none", fontSize: "0.74rem" }}>{meta.linkLabel ?? "Open"}</Link>}
        </div>
      )}
    </div>
  );
}

function ClusterBlock({ privileged }: { privileged: boolean }) {
  const { data: pm } = useQuery({
    queryKey: ["proxmox-status"],
    queryFn: () => api<{ connected: boolean; version?: string; nodes?: NodeStatus[] }>("/proxmox/status"),
    refetchInterval: 15000,
    enabled: privileged,
  });
  if (!privileged) return null;
  const nodes = pm?.nodes ?? [];
  if (!nodes.length) return null;
  return (
    <Section title={pm?.connected ? `Cluster — Proxmox VE ${pm.version ?? ""}` : "Cluster"} hint={!pm?.connected ? "disconnected" : undefined}>
      {nodes.map((n) => {
        const cpu = n.maxcpu ? Math.min(100, (n.cpu / n.maxcpu) * 100) : 0;
        const mem = n.maxmem ? Math.min(100, (n.mem / n.maxmem) * 100) : 0;
        return (
          <div key={n.node} style={{ padding: "11px 0", borderBottom: "1px solid var(--pv-border-soft)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 7 }}>
              <span style={{ fontWeight: 600, display: "inline-flex", gap: 8, alignItems: "center" }}>
                {n.node} <StatusBadge status={n.status === "online" ? "running" : "stopped"} />
              </span>
              <span className="pv-faint pv-mono" style={{ fontSize: "0.78rem" }}>
                {cpu.toFixed(0)}% CPU · {mem.toFixed(0)}% RAM
              </span>
            </div>
            <div style={{ display: "grid", gap: 5 }}>
              <Meter value={cpu} max={100} tone={utilTone(cpu)} title={`${n.node} CPU ${cpu.toFixed(0)}%`} />
              <Meter value={mem} max={100} tone={utilTone(mem)} title={`${n.node} RAM ${mem.toFixed(0)}%`} />
            </div>
          </div>
        );
      })}
    </Section>
  );
}

function ReachabilityChips() {
  const { data } = useQuery({
    queryKey: ["connection-health"],
    queryFn: () => api<{ health: Array<{ protocol: string; reachable: boolean }> }>("/connection-health"),
    refetchInterval: 30000,
  });
  const rows = data?.health ?? [];
  if (!rows.length) return null;
  const byProto = new Map<string, { up: number; total: number }>();
  for (const r of rows) {
    const agg = byProto.get(r.protocol) ?? { up: 0, total: 0 };
    agg.total += 1;
    if (r.reachable) agg.up += 1;
    byProto.set(r.protocol, agg);
  }
  return (
    <Section title="Guest sessions" hint="Per-protocol reachability of VMs you can access (latest background snapshot).">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {[...byProto.entries()].map(([proto, agg]) => (
          <span key={proto} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <Badge tone={agg.up === agg.total ? "ok" : agg.up === 0 ? "err" : "warn"}>
              {proto.toUpperCase()}
            </Badge>
            <span className="pv-mono" style={{ fontSize: "0.78rem", color: "var(--pv-text-2)" }}>
              {agg.up}/{agg.total} reachable
            </span>
          </span>
        ))}
      </div>
    </Section>
  );
}

export default function Health({ can }: { can?: (perm: string) => boolean }) {
  const { data, error } = useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ healthy: boolean; checks: Check[] }>("/health"),
    refetchInterval: 15000,
  });

  const checks = data?.checks ?? [];
  const broken = checks.filter((c) => c.status === "ERROR" || c.status === "OFFLINE");
  const degraded = checks.filter((c) => c.status === "UNCONFIGURED");
  // UNCONFIGURED optional services are not outages: only broken ones count.
  const allOperational = checks.length > 0 && broken.length === 0;
  const sorted = [...GROUPS.flatMap((g) => checks.filter((c) => (SERVICES[c.name]?.group ?? "?") === g))];

  return (
    <div className="pv-page">
      <PageHeader
        title="System status"
        description={
          error
            ? `Cannot load health checks: ${explainDenial(error) ?? String(error)}`
            : data
              ? allOperational
                ? degraded.length
                  ? `All configured services operational — ${degraded.length} optional service${degraded.length === 1 ? "" : "s"} not set up.`
                  : "All services operational."
                : `${broken.length} service${broken.length === 1 ? "" : "s"} down: ${broken.map((c) => SERVICES[c.name]?.label ?? c.name).join(", ")}.`
              : "Running checks…"
        }
      />
      {/* Hero: the one-glance signal, first thing painted. */}
      {data && (
        <div
          role="status"
          className="pv-panel"
          style={{
            padding: "14px 18px",
            marginBottom: 18,
            display: "flex",
            alignItems: "center",
            gap: 12,
            borderLeft: `4px solid ${allOperational ? "var(--pv-ok)" : "var(--pv-err)"}`,
          }}
        >
          <span style={{ fontSize: "1.3rem", color: allOperational ? "var(--pv-ok)" : "var(--pv-err)" }} aria-hidden>
            {allOperational ? "✔" : "✖"}
          </span>
          <span style={{ fontSize: "0.95rem", fontWeight: 650 }}>
            {allOperational ? "All systems operational" : `${broken.length} service${broken.length === 1 ? "" : "s"} down`}
          </span>
          {degraded.length > 0 && (
            <span className="pv-faint" style={{ marginLeft: "auto", fontSize: "0.78rem" }}>
              {degraded.length} not configured ({degraded.map((c) => SERVICES[c.name]?.label ?? c.name).join(", ")})
            </span>
          )}
        </div>
      )}
      {!data && !error && <EmptyState title="Running checks…" />}
      {error && <EmptyState title="Health endpoint unreachable" body={explainDenial(error) ?? undefined} />}
      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, marginBottom: 8 }}>
          {sorted.map((c) => (
            <Tile key={c.name} check={c} />
          ))}
        </div>
      )}
      <ReachabilityChips />
      <ClusterBlock privileged={!!can?.("proxmox.read")} />
      <Section title="Public status" hint="Independent uptime tracking (Uptime Kuma), including history ProxVM itself can't see while down.">
        <a
          className="pv-btn"
          href="https://uptime.benmoyer.org/status/home"
          target="_blank"
          rel="noopener noreferrer"
        >
          Open status page
        </a>
      </Section>
    </div>
  );
}
