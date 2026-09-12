import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { StatusBadge, PageTitle, ErrorBox } from "../components/ui.js";

interface Me {
  id: string;
  username: string;
  roles: string[];
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

export default function Dashboard({ me }: { me: Me }) {
  const privileged = isPrivileged(me.roles);

  const { data: pm, error: pmError } = useQuery({
    queryKey: ["proxmox-status"],
    queryFn: () => api<{ connected: boolean; version?: string; nodes?: Array<{ node: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number; uptime: number }> }>("/proxmox/status"),
    refetchInterval: 15000,
    enabled: privileged,
  });
  const { data: vmsData } = useQuery({
    queryKey: ["vms"],
    queryFn: () => api<{ vms: Array<{ id: string | null; vmid: number; name: string; status: string; ip: string | null; guacamole: { created: boolean } | null; credentialStatus: string | null }> }>("/vms"),
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

  const vmList = vmsData?.vms ?? [];
  const running = vmList.filter((v) => v.status === "running").length;
  const stopped = vmList.filter((v) => v.status === "stopped").length;
  const nodes = pm?.nodes ?? [];
  const totalCpu = nodes.reduce((a, n) => a + n.maxcpu, 0);
  const usedCpu = nodes.reduce((a, n) => a + n.cpu * n.maxcpu, 0);
  const totalMem = nodes.reduce((a, n) => a + n.maxmem, 0);
  const usedMem = nodes.reduce((a, n) => a + n.mem, 0);

  const card = "bg-slate-900 border border-slate-800 rounded-lg p-4";
  const stat = (label: string, value: string | number, cls = "") => (
    <div className={card} key={label}>
      <div className="text-xs text-slate-400 mb-1">{label}</div>
      <div className={`text-2xl font-semibold ${cls}`}>{value}</div>
    </div>
  );

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Dashboard</h1>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        {stat("Total VMs", String((vmList).length ?? "—"))}
        {stat("Running", String(running), "text-green-400")}
        {stat("Stopped", String(stopped))}
        {stat("Failed", String((vmList).filter((v) => v.status === "failed").length ?? 0), "text-red-400")}
        {stat("Active Jobs", String(jobs?.jobs.filter((j) => !["READY", "FAILED", "CANCELLED"].includes(j.status)).length ?? 0), "text-blue-400")}
      </div>
      {privileged && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className={card}>
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
            <div className="text-xs text-slate-500 mt-2">Cluster: {totalCpu} cores · {bytes(totalMem)} RAM ({pct(usedMem, totalMem)?.toFixed(0)}% used)</div>
          </div>
          <div className={card}>
            <div className="text-xs text-slate-400 mb-2">Recent events</div>
            {(audit?.entries ?? []).map((e) => (
              <div key={e.id} className="text-sm py-0.5 flex justify-between text-slate-300">
                <span>{e.event}</span>
                <span className="text-slate-500">{e.actorUsername ?? "system"} · {new Date(e.createdAt).toLocaleString()}</span>
              </div>
            ))}
            {!audit?.entries.length && <div className="text-sm text-slate-500">No events yet</div>}
          </div>
        </div>
      )}
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
    </div>
  );
}