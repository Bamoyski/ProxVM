import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { StatusBadge, PageTitle, ErrorBox } from "../components/ui.js";

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
  const nodes = pm?.nodes ?? [];

  const servicesByVm = useMemo(() => {
    const map = new Map<string, Array<{ port: number; service: string }>>();
    for (const entry of servicesData?.vmServices ?? []) map.set(entry.vmId, entry.services);
    return map;
  }, [servicesData]);

  const balanceTip = useMemo(() => {
    if (nodes.length < 2) return null;
    const ranked = nodes
      .map((n) => ({ node: n.node, pct: pct(n.mem, n.maxmem) ?? 0 }))
      .sort((a, b) => b.pct - a.pct);
    const top = ranked[0]!;
    const bottom = ranked[ranked.length - 1]!;
    if (top.pct - bottom.pct < 25) return null;
    return `${top.node} RAM is ${top.pct.toFixed(0)}% full vs ${bottom.node} at ${bottom.pct.toFixed(0)}% — consider migrating a VM (open it from Virtual Machines → Migrate).`;
  }, [nodes]);

  const runDiscovery = async (): Promise<void> => {
    setError(null);
    try {
      await api("/discovery/run", { method: "POST", body: {} });
      void qc.invalidateQueries({ queryKey: ["vm-services"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const card = "bg-slate-900 border border-slate-800 rounded-lg p-4";
  const stat = (label: string, value: string | number, cls = "") => (
    <div className={card} key={label}>
      <div className="text-xs text-slate-400 mb-1">{label}</div>
      <div className={`text-2xl font-semibold ${cls}`}>{value}</div>
    </div>
  );

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

  const widgets: Record<WidgetId, { privilegedOnly: boolean; node: React.ReactNode }> = {
    stats: {
      privilegedOnly: false,
      node: (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          {stat("Total VMs", String((vmList).length ?? "—"))}
          {stat("Running", String(running), "text-green-400")}
          {stat("Stopped", String(stopped))}
          {stat("Failed", String((vmList).filter((v) => v.status === "failed").length ?? 0), "text-red-400")}
          {stat("Active Jobs", String(jobs?.jobs.filter((j) => !["READY", "FAILED", "CANCELLED"].includes(j.status)).length ?? 0), "text-blue-400")}
        </div>
      ),
    },
    proxmox: {
      privilegedOnly: true,
      node: (
        <div className={`${card} mb-6`}>
          <div className="text-xs text-slate-400 mb-2">
            Proxmox {pm?.connected ? `v${pm.version}` : "— disconnected"}
          </div>
          {pmError && <div className="bg-red-900/50 border border-red-700 text-red-200 rounded p-3 mb-4">Failed to load Proxmox status: {String(pmError)}</div>}
          {!pm?.connected && pm && (
            <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-200 rounded p-3 mb-4">
              Proxmox is disconnected: {String((pm as { error?: string }).error ?? "unknown error")}
            </div>
          )}
          {nodes.map((n) => (
            <div key={n.node} className="mb-2">
              <div className="flex justify-between text-sm mb-1">
                <span>
                  {n.node} <StatusBadge status={n.status === "online" ? "running" : "stopped"} />
                </span>
                <span className="text-slate-400 text-xs">
                  {pct(n.cpu, n.maxcpu)?.toFixed(0)}% CPU · {bytes(n.mem)}/{bytes(n.maxmem)} RAM
                </span>
              </div>
              <div className="w-full bg-slate-800 rounded h-1.5">
                <div className="bg-blue-500 h-1.5 rounded" style={{ width: `${pct(n.cpu, n.maxcpu) ?? 0}%` }} />
              </div>
            </div>
          ))}
          {balanceTip && (
            <div className="bg-yellow-900/40 border border-yellow-700/60 text-yellow-200 rounded p-3 mt-3 text-sm">
              ⚖ {balanceTip}
            </div>
          )}
        </div>
      ),
    },
    discovery: {
      privilegedOnly: false,
      node: (
        <div className={`${card} mb-6`}>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-slate-400">Discovered services</div>
            {privileged && (
              <button onClick={() => void runDiscovery()} className="text-xs px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded">
                Scan now
              </button>
            )}
          </div>
          {[...servicesByVm.entries()].map(([vmId, services]) => {
            const vm = vmList.find((v) => v.id === vmId);
            if (!vm) return null;
            return (
              <div key={vmId} className="text-sm py-1 flex flex-wrap items-center gap-2">
                <Link to={`/vms/${vmId}`} className="text-blue-400 hover:underline">{vm.name}</Link>
                {services.map((s) => (
                  <span key={s.port} className="text-xs bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5" title={`Port ${s.port}`}>
                    {s.service} · {s.port}
                  </span>
                ))}
              </div>
            );
          })}
          {!servicesByVm.size && (
            <div className="text-sm text-slate-500">No scan results yet{privileged ? " — press Scan now." : "."}</div>
          )}
        </div>
      ),
    },
    events: {
      privilegedOnly: true,
      node: (
        <div className={`${card} mb-6`}>
          <div className="text-xs text-slate-400 mb-2">Recent events</div>
          {(audit?.entries ?? []).map((e) => (
            <div key={e.id} className="text-sm py-0.5 flex justify-between text-slate-300">
              <span>{e.event}</span>
              <span className="text-slate-500">{e.actorUsername ?? "system"} · {new Date(e.createdAt).toLocaleString()}</span>
            </div>
          ))}
          {!audit?.entries.length && <div className="text-sm text-slate-500">No events yet</div>}
        </div>
      ),
    },
    jobs: {
      privilegedOnly: false,
      node: (
        <div className={card}>
          <div className="text-xs text-slate-400 mb-2">Recent provisioning jobs</div>
          {(jobs?.jobs ?? []).map((j) => (
            <div key={j.id} className="flex justify-between text-sm py-0.5">
              <span className="font-mono text-xs">{j.id.slice(0, 8)}</span>
              <StatusBadge status={j.status} />
              <span className="text-slate-500">{new Date(j.createdAt).toLocaleString()}</span>
            </div>
          ))}
          {!jobs?.jobs.length && <div className="text-sm text-slate-500">No provisioning jobs yet</div>}
        </div>
      ),
    },
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <button
          onClick={() => setCustomizing((v) => !v)}
          className="text-xs px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded"
        >
          {customizing ? "Done" : "Customize"}
        </button>
      </div>
      {error && <ErrorBox error={error} />}
      {customizing && (
        <div className={`${card} mb-6`}>
          <div className="text-xs text-slate-400 mb-2">Arrange widgets (saved in this browser)</div>
          <div className="space-y-1">
            {layout.order.map((id) => (
              <div key={id} className="flex items-center gap-2 text-sm">
                <button
                  onClick={() => toggleWidget(id)}
                  className={`w-4 h-4 rounded border text-[10px] leading-none ${layout.hidden.includes(id) ? "border-slate-600 text-transparent" : "bg-blue-600 border-blue-500 text-white"}`}
                  aria-label={`Toggle ${id}`}
                >
                  ✓
                </button>
                <span className={layout.hidden.includes(id) ? "text-slate-500" : "text-slate-200"}>
                  {ALL_WIDGETS.find((w) => w.id === id)?.title}
                </span>
                <span className="ml-auto flex gap-1">
                  <button className="text-xs text-slate-400 hover:text-slate-200" onClick={() => moveWidget(id, -1)}>↑</button>
                  <button className="text-xs text-slate-400 hover:text-slate-200" onClick={() => moveWidget(id, 1)}>↓</button>
                </span>
              </div>
            ))}
          </div>
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
