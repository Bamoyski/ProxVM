import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { StatusBadge, PageTitle, ErrorBox, Section, Empty, Btn } from "../components/ui.js";

interface Me {
  id: string;
  username: string;
  roles: string[];
}

interface NodeStatus {
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
}

interface VmRow {
  id: string | null;
  vmid: number;
  name: string;
  node: string;
  status: string;
  ip: string | null;
}

function bytes(n: unknown): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
}

function pct(used: unknown, max: unknown): number | null {
  if (used === null || used === undefined || !max) return null;
  return Math.min(100, (Number(used) / Number(max)) * 100);
}

function isPrivileged(roles: string[]): boolean {
  return roles.some((r) => r === "ADMIN" || r === "OPERATOR");
}

type WidgetId = "stats" | "proxmox" | "discovery" | "events" | "jobs";

const ALL_WIDGETS: Array<{ id: WidgetId; title: string }> = [
  { id: "stats", title: "Overview" },
  { id: "proxmox", title: "Cluster & balance" },
  { id: "discovery", title: "Discovered services" },
  { id: "events", title: "Recent events" },
  { id: "jobs", title: "Recent provisioning jobs" },
];

interface Layout {
  order: WidgetId[];
  hidden: WidgetId[];
}

function loadLayout(): Layout {
  const fallback: Layout = { order: ALL_WIDGETS.map((w) => w.id), hidden: [] };
  try {
    const raw = window.localStorage.getItem("proxvm-dashboard-v1");
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Layout>;
    const order = (parsed.order ?? []).filter((id): id is WidgetId => ALL_WIDGETS.some((w) => w.id === id));
    for (const w of ALL_WIDGETS) if (!order.includes(w.id)) order.push(w.id);
    const hidden = (parsed.hidden ?? []).filter((id): id is WidgetId => ALL_WIDGETS.some((w) => w.id === id));
    return { order, hidden };
  } catch {
    return fallback;
  }
}

export default function Dashboard({ me }: { me: Me }) {
  const qc = useQueryClient();
  const privileged = isPrivileged(me.roles);
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const [customizing, setCustomizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveLayout = (next: Layout): void => {
    setLayout(next);
    try {
      window.localStorage.setItem("proxvm-dashboard-v1", JSON.stringify(next));
    } catch {
      // private mode: layout just won't persist
    }
  };

  const { data: pm, error: pmError } = useQuery({
    queryKey: ["proxmox-status"],
    queryFn: () => api<{ connected: boolean; version?: string; nodes?: NodeStatus[] }>("/proxmox/status"),
    refetchInterval: 15000,
    enabled: privileged,
  });
  const { data: vmsData } = useQuery({
    queryKey: ["vms"],
    queryFn: () => api<{ vms: Array<VmRow & { guacamole: { created: boolean } | null; credentialStatus: string | null }> }>("/vms"),
    refetchInterval: 15000,
  });
  const { data: jobs } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<{ jobs: Array<{ id: string; status: string; error: string | null; createdAt: string }> }>("/jobs?limit=5"),
    refetchInterval: 10000,
  });
  const { data: audit } = useQuery({
    queryKey: ["audit-recent"],
    queryFn: () => api<{ entries: Array<{ id: string; event: string; actorUsername: string | null; createdAt: string }> }>("/audit?limit=10"),
    enabled: privileged,
  });
  const { data: servicesData } = useQuery({
    queryKey: ["vm-services"],
    queryFn: () => api<{ vmServices: Array<{ vmId: string; services: Array<{ port: number; service: string }> }> }>("/vm-services"),
    refetchInterval: 60000,
  });

  const vmList = vmsData?.vms ?? [];
  const running = vmList.filter((v) => v.status === "running").length;
  const stopped = vmList.filter((v) => v.status === "stopped").length;
  const failed = vmList.filter((v) => v.status === "failed").length;
  const activeJobs = jobs?.jobs.filter((j) => !["READY", "FAILED", "CANCELLED"].includes(j.status)).length ?? 0;
  const nodes = pm?.nodes ?? [];

  const servicesByVm = useMemo(() => {
    const map = new Map<string, Array<{ port: number; service: string }>>();
    for (const entry of servicesData?.vmServices ?? []) map.set(entry.vmId, entry.services);
    return map;
  }, [servicesData]);

  const balanceTip = useMemo(() => {
    // Offline nodes report stale numbers — leave them out of the math
    // entirely (they still render below with their status).
    const online = nodes.filter((n) => n.status === "online");
    if (online.length < 2) return null;
    const ranked = online
      .map((n) => ({ node: n.node, pct: pct(n.mem, n.maxmem) ?? 0 }))
      .sort((a, b) => b.pct - a.pct);
    const top = ranked[0]!;
    const bottom = ranked[ranked.length - 1]!;
    // Only nag when it matters: a big spread AND the fullest node actually
    // under pressure. Anything milder isn't worth an alarm.
    if (top.pct - bottom.pct < 25 || top.pct < 80) return null;
    return `${top.node} RAM is ${top.pct.toFixed(0)}% full vs ${bottom.node} at ${bottom.pct.toFixed(0)}% — consider migrating a VM (open it from Virtual Machines → Migrate).`;
  }, [nodes]);

  const [dismissedTip, setDismissedTip] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem("proxvm-balance-dismissed");
    } catch {
      return null;
    }
  });
  const showTip = balanceTip !== null && balanceTip !== dismissedTip;
  const dismissTip = (): void => {
    try {
      if (balanceTip) window.localStorage.setItem("proxvm-balance-dismissed", balanceTip);
    } catch {
      // private mode: dismissal just won't persist
    }
    setDismissedTip(balanceTip);
  };

  const runDiscovery = async (): Promise<void> => {
    setError(null);
    try {
      await api("/discovery/run", { method: "POST", body: {} });
      void qc.invalidateQueries({ queryKey: ["vm-services"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const moveWidget = (id: WidgetId, dir: -1 | 1): void => {
    const order = [...layout.order];
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    saveLayout({ ...layout, order });
  };

  const toggleWidget = (id: WidgetId): void => {
    const hidden = layout.hidden.includes(id) ? layout.hidden.filter((h) => h !== id) : [...layout.hidden, id];
    saveLayout({ ...layout, hidden });
  };

  const statItems: Array<{ label: string; value: string; tone?: string }> = [
    { label: "Total VMs", value: String(vmList.length) },
    { label: "Running", value: String(running), tone: "var(--pv-ok)" },
    { label: "Stopped", value: String(stopped) },
    ...(failed ? [{ label: "Failed", value: String(failed), tone: "var(--pv-err)" }] : []),
    ...(activeJobs ? [{ label: "Active jobs", value: String(activeJobs), tone: "var(--pv-info)" }] : []),
  ];

  const widgets: Record<WidgetId, { privilegedOnly: boolean; node: React.ReactNode }> = {
    stats: {
      privilegedOnly: false,
      node: (
        <dl style={{ display: "flex", gap: 28, flexWrap: "wrap", margin: "0 0 26px" }}>
          {statItems.map((s) => (
            <div key={s.label}>
              <dt style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--pv-text-3)" }}>{s.label}</dt>
              <dd style={{ margin: 0, fontSize: "1.5rem", fontWeight: 650, color: s.tone ?? "var(--pv-text)", fontVariantNumeric: "tabular-nums" }}>{s.value}</dd>
            </div>
          ))}
        </dl>
      ),
    },
    proxmox: {
      privilegedOnly: true,
      node: (
        <Section
          title={`Cluster${pm?.connected && pm.version ? ` — Proxmox VE ${pm.version}` : ""}`}
          hint={!pm?.connected ? "disconnected" : undefined}
        >
          {pmError && <ErrorBox error={`Failed to load Proxmox status: ${String(pmError)}`} />}
          {!pm?.connected && pm && (
            <div className="pv-notice pv-notice-warn">
              Proxmox is disconnected: {String((pm as { error?: string }).error ?? "unknown error")}
            </div>
          )}
          {nodes.map((n) => {
            const cpu = pct(n.cpu, n.maxcpu) ?? 0;
            const mem = pct(n.mem, n.maxmem) ?? 0;
            return (
              <div key={n.node} style={{ padding: "10px 0", borderBottom: "1px solid var(--pv-border-soft)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                  <span style={{ fontWeight: 600 }}>{n.node} <StatusBadge status={n.status === "online" ? "running" : "stopped"} /></span>
                  <span style={{ color: "var(--pv-text-2)", fontSize: "0.8rem", fontVariantNumeric: "tabular-nums" }}>
                    {cpu.toFixed(0)}% CPU · {bytes(n.mem)}/{bytes(n.maxmem)} RAM
                  </span>
                </div>
                <div className={`pv-meter${mem >= 80 ? " pv-meter-hot" : ""}`} title={`${mem.toFixed(0)}% RAM used`}>
                  <i style={{ width: `${cpu}%` }} />
                </div>
              </div>
            );
          })}
          {showTip && balanceTip && (
            <div className="pv-notice pv-notice-warn" style={{ display: "flex", gap: 12, marginTop: 12 }}>
              <span style={{ flex: 1 }}>{balanceTip}</span>
              <button className="pv-btn pv-btn-link" style={{ fontSize: "0.78rem", flex: "none" }} onClick={dismissTip} title="Hide this suggestion (it returns if the situation changes)">
                Dismiss
              </button>
            </div>
          )}
        </Section>
      ),
    },
    discovery: {
      privilegedOnly: false,
      node: (
        <Section
          title="Discovered services"
          actions={privileged ? <Btn size="sm" onClick={() => void runDiscovery()}>Scan now</Btn> : undefined}
        >
          {[...servicesByVm.entries()].map(([vmId, services]) => {
            const vm = vmList.find((v) => v.id === vmId);
            if (!vm) return null;
            return (
              <div key={vmId} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
                <Link to={`/vms/${vmId}`}>{vm.name}</Link>
                {services.map((s) => (
                  <span key={s.port} className="pv-mono" title={`Port ${s.port}`} style={{ color: "var(--pv-text-2)" }}>
                    {s.service} · {s.port}
                  </span>
                ))}
              </div>
            );
          })}
          {!servicesByVm.size && (
            <Empty title="No scan results yet" body={privileged ? "Run a discovery scan to map open services to VMs." : undefined} />
          )}
        </Section>
      ),
    },
    events: {
      privilegedOnly: true,
      node: (
        <Section title="Recent events">
          {(audit?.entries ?? []).map((e) => (
            <div key={e.id} style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "6px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
              <span className="pv-mono">{e.event}</span>
              <span style={{ color: "var(--pv-text-3)", whiteSpace: "nowrap" }}>{e.actorUsername ?? "system"} · {new Date(e.createdAt).toLocaleString()}</span>
            </div>
          ))}
          {!audit?.entries.length && <Empty title="No events yet" body="Actions across the fleet will appear here." />}
        </Section>
      ),
    },
    jobs: {
      privilegedOnly: false,
      node: (
        <Section title="Recent provisioning jobs">
          {(jobs?.jobs ?? []).map((j) => (
            <div key={j.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "6px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
              <span className="pv-mono">{j.id.slice(0, 8)}</span>
              <StatusBadge status={j.status} />
              <span style={{ marginLeft: "auto", color: "var(--pv-text-3)" }}>{new Date(j.createdAt).toLocaleString()}</span>
            </div>
          ))}
          {!jobs?.jobs.length && <Empty title="No provisioning jobs yet" body="Provisioning a VM from a template creates a tracked job here." />}
        </Section>
      ),
    },
  };

  return (
    <div className="pv-page">
      <PageTitle
        title="Dashboard"
        description={privileged ? "Fleet state at a glance. Rearrange or hide sections with Customize." : "Your virtual machines and recent activity."}
      >
        <Btn size="sm" onClick={() => setCustomizing((v) => !v)}>{customizing ? "Done" : "Customize"}</Btn>
      </PageTitle>
      {error && <ErrorBox error={error} />}
      {customizing && (
        <div className="pv-panel" style={{ marginBottom: 20 }}>
          <div className="pv-label" style={{ marginBottom: 8 }}>Arrange sections (saved in this browser)</div>
          {layout.order.map((id) => (
            <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", fontSize: "0.85rem" }}>
              <button
                onClick={() => toggleWidget(id)}
                style={{
                  width: 16, height: 16, borderRadius: 4, border: "1px solid var(--pv-border)",
                  background: layout.hidden.includes(id) ? "transparent" : "var(--pv-accent)",
                  borderColor: layout.hidden.includes(id) ? "var(--pv-border)" : "var(--pv-accent)",
                  color: "#fff", fontSize: 10, lineHeight: 1, cursor: "pointer",
                }}
                aria-label={`Toggle ${id}`}
              >
                ✓
              </button>
              <span style={{ color: layout.hidden.includes(id) ? "var(--pv-text-3)" : "var(--pv-text)" }}>
                {ALL_WIDGETS.find((w) => w.id === id)?.title}
              </span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                <Btn size="sm" kind="link" onClick={() => moveWidget(id, -1)}>↑</Btn>
                <Btn size="sm" kind="link" onClick={() => moveWidget(id, 1)}>↓</Btn>
              </span>
            </div>
          ))}
        </div>
      )}
      {layout.order
        .filter((id) => !layout.hidden.includes(id))
        .filter((id) => privileged || !widgets[id]!.privilegedOnly)
        .map((id) => (
          <div key={id}>{widgets[id]!.node}</div>
        ))}
    </div>
  );
}
