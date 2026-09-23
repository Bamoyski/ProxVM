import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { makeCan, useEffectivePermissions } from "../iam.js";
import { StatusBadge, PageTitle, ErrorBox, useConfirm } from "../components/ui.js";

interface VmRow {
  id: string | null;
  vmid: number;
  node: string;
  name: string;
  tracked: boolean;
  status: string;
  osType: string | null;
  osName: string | null;
  os: string | null;
  ip: string | null;
  cpu: { used: number | null; max: number } | null;
  mem: { used: number | null; max: number } | null;
  disk: { used: number | null; max: number } | null;
  uptime: number | null;
  guacamole: { created: boolean; status: string | null; protocol: string | null; port: number | null } | null;
  credentialStatus: string | null;
  private?: boolean;
}

function fmtBytes(n: unknown): string {
  if (n === null || n === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(0)} ${units[u]}`;
}

interface Me {
  id: string;
  username: string;
  roles: string[];
}

function hasPermission(me: Me, perm: string): boolean {
  const rolePerms: Record<string, string[]> = {
    ADMIN: [
      "vm.list", "vm.read", "vm.create", "vm.manage", "vm.edit", "vm.delete", "vm.provision",
      "cred.reveal", "cred.rotate",
      "guac.launch", "guac.manage",
      "users.manage",
      "templates.manage",
      "audit.read",
      "jobs.read", "jobs.retry", "jobs.cancel",
      "settings.manage",
      "health.read",
      "proxmox.read",
    ],
    OPERATOR: [
      "vm.list", "vm.read", "vm.create", "vm.manage", "vm.edit", "vm.provision",
      "cred.rotate",
      "guac.launch", "guac.manage",
      "jobs.read", "jobs.retry", "jobs.cancel",
      "health.read",
      "proxmox.read",
    ],
    USER: [
      "vm.read",
      "guac.launch",
      "jobs.read",
      "health.read",
    ],
  };
  return me.roles.some((r) => rolePerms[r]?.includes(perm));
}

export default function Vms({ me }: { me: Me }) {
  const qc = useQueryClient();
  const can = makeCan(useEffectivePermissions(), (perm) => hasPermission(me, perm));
  const canCreate = can("vm.create");
  const canManage = can("vm.manage");
  const canEdit = can("vm.edit");
  const canDelete = can("vm.delete");
  const canLaunch = can("guac.launch");
  const { data, error } = useQuery({
    queryKey: ["vms"],
    queryFn: () => api<{ vms: VmRow[]; proxmoxConnected: boolean; proxmoxError: string | null }>("/vms"),
    refetchInterval: 10000,
  });
  const { data: templates } = useQuery({
    queryKey: ["templates"],
    queryFn: () =>
      api<{ templates: Array<{ id: string; name: string; node: string; proxmoxVmid: number; osType: string; provisioningMethod: string; defaultCpu: number; defaultRamMb: number; defaultDiskGb: number; supportedProtocols?: string[] }> }>("/templates"),
  });
  const { confirm, dialog } = useConfirm();

  const [provisionOpen, setProvisionOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const { data: healthData } = useQuery({
    queryKey: ["connection-health"],
    queryFn: () => api<{ health: Array<{ vmId: string; protocol: string; reachable: boolean; authenticated: boolean | null; detail: string }> }>("/connection-health"),
    refetchInterval: 60000,
  });
  const [provisionMode, setProvisionMode] = useState<"basic" | "advanced">("basic");
  const [assignIds, setAssignIds] = useState<string[]>([]);
  const [basic, setBasic] = useState({
    name: "",
    templateId: "",
    cpu: 2,
    ramMb: 2048,
    diskGb: 20,
    bridge: "",
    protocols: [] as string[],
  });
  const [form, setForm] = useState({
    name: "",
    templateId: "",
    node: "",
    vmid: "",
    cpu: 2,
    ramMb: 2048,
    diskGb: 20,
    storage: "",
    bridge: "",
    vlan: "",
    mode: "dhcp" as "dhcp" | "static",
    ip: "",
    cidr: "24",
    gateway: "",
    dns: "",
    guestUser: "deploy",
    password: "",
    linkedClone: true,
    protocols: ["ssh"] as string[],
  });
  const { data: nodes } = useQuery({
    queryKey: ["proxmox-nodes"],
    queryFn: () => api<{ nodes: Array<{ node: string; status: string }> }>("/proxmox/nodes"),
    enabled: provisionOpen,
  });
  const selNode = form.node || nodes?.nodes[0]?.node || "";
  const { data: storage } = useQuery({
    queryKey: ["proxmox-storage", selNode],
    queryFn: () => api<{ storage: Array<{ storage: string; node: string; content: string; type: string }> }>(`/proxmox/storage?node=${encodeURIComponent(selNode)}`),
    enabled: provisionOpen && !!selNode,
  });
  const { data: networks } = useQuery({
    queryKey: ["proxmox-networks", selNode],
    queryFn: () => api<{ networks: Array<{ iface: string; type: string; active: number }> }>(`/proxmox/networks?node=${encodeURIComponent(selNode)}`),
    enabled: provisionOpen && !!selNode,
  });
  const { data: generated } = useQuery({
    queryKey: ["genpw", provisionOpen],
    queryFn: () => api<{ password: string }>("/credentials/generate", { method: "POST" }),
    enabled: provisionOpen,
    staleTime: 0,
    gcTime: 0,
  });
  const { data: provisionDefaults } = useQuery({
    queryKey: ["provision-defaults", basic.templateId || form.templateId],
    queryFn: () =>
      api<{
        node: string | null; storage: string | null; bridge: string;
        cpu: number; ramMb: number; diskGb: number; guestUser: string;
        protocols: string[]; verified: boolean; warnings: string[];
      }>(`/provisioning/defaults?templateId=${encodeURIComponent(basic.templateId || form.templateId)}`),
    enabled: provisionOpen && (!!(basic.templateId || form.templateId)),
  });
  const { data: allUsers } = useQuery({
    queryKey: ["users"],
    queryFn: () => api<{ users: Array<{ id: string; username: string; roles: string[] }> }>("/users"),
    enabled: provisionOpen,
    retry: false,
  });

  const applyTemplate = (templateId: string) => {
    const t = templates?.templates.find((x) => x.id === templateId);
    const supported = t?.supportedProtocols?.length ? t.supportedProtocols : [t?.osType === "windows" ? "rdp" : "ssh"];
    setForm((f) => ({ ...f, templateId, node: t?.node ?? "", cpu: t?.defaultCpu ?? 2, ramMb: t?.defaultRamMb ?? 2048, diskGb: t?.defaultDiskGb ?? 20, protocols: supported }));
    setBasic((b) => ({
      ...b,
      templateId,
      cpu: t?.defaultCpu ?? 2,
      ramMb: t?.defaultRamMb ?? 2048,
      diskGb: t?.defaultDiskGb ?? 20,
      bridge: "",
      protocols: supported,
    }));
  };

  const toggleAssign = (userId: string) =>
    setAssignIds((prev) => (prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]));

  // Guards the provision submit buttons while a request is in flight so a
  // double-click cannot enqueue two identical provisioning jobs (the API
  // also rejects same-name active duplicates with 409 as a second layer).
  const [submitting, setSubmitting] = useState(false);
  const submitGuarded = (fn: () => Promise<void>) => async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await fn();
    } finally {
      setSubmitting(false);
    }
  };

  const provisionBasic = async () => {
    if (!basic.name || !basic.templateId || !generated) return;
    try {
      // Intentionally partial: node/storage/guestUser are resolved server-side
      // from configured defaults; only explicitly chosen values are sent.
      await api("/vms/provision", {
        method: "POST",
        body: {
          name: basic.name,
          templateId: basic.templateId,
          cpu: basic.cpu,
          ramMb: basic.ramMb,
          diskGb: basic.diskGb,
          network: { bridge: basic.bridge || undefined, mode: "dhcp" },
          protocols: basic.protocols.length ? basic.protocols : undefined,
          password: generated.password,
          assignToUserIds: assignIds,
        },
      });
      setProvisionOpen(false);
      setAssignIds([]);
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["vms"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const provision = async () => {
    const tmpl = templates?.templates.find((t) => t.id === form.templateId);
    if (!tmpl || !generated) return;
    try {
      await api("/vms/provision", {
        method: "POST",
        body: {
          name: form.name,
          templateId: form.templateId,
          node: form.node || tmpl.node,
          vmid: form.vmid ? Number(form.vmid) : undefined,
          cpu: form.cpu,
          ramMb: form.ramMb,
          diskGb: form.diskGb,
          storage: form.storage,
          network: {
            bridge: form.bridge,
            vlan: form.vlan ? Number(form.vlan) : undefined,
            mode: form.mode,
            ip: form.mode === "static" ? form.ip : undefined,
            cidr: form.mode === "static" ? Number(form.cidr) : undefined,
            gateway: form.mode === "static" ? form.gateway : undefined,
            dns: form.dns ? form.dns.split(/[\s,]+/).filter(Boolean) : undefined,
          },
          osType: tmpl.osType,
          protocols: form.protocols.length ? form.protocols : undefined,
          guestUser: form.guestUser,
          password: generated.password,
          linkedClone: form.linkedClone,
          assignToUserIds: assignIds,
        },
      });
      setProvisionOpen(false);
      setAssignIds([]);
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["vms"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const doAction = async (id: string, action: string) => {
    try {
      await api(`/vms/${id}/${action}`, { method: "POST", body: {} });
      void qc.invalidateQueries({ queryKey: ["vms"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const detectIp = async (id: string) => {
    try {
      const res = await api<{ detected: boolean; ip?: string; reason?: string }>(`/vms/${id}/detect-ip`, { method: "POST" });
      if (!res.detected) alert(res.reason ?? "IP could not be detected");
      void qc.invalidateQueries({ queryKey: ["vms"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const launchGuac = async (id: string, protocol?: string) => {
    try {
      const res = await api<{ url: string; mode?: string; detail?: string }>(`/vms/${id}/guacamole/launch`, {
        method: "POST",
        body: protocol ? { protocol } : {},
      });
      if (res.mode === "login" && res.detail) {
        alert(`Guacamole could not start a direct session: ${res.detail}\n\nOpening the Guacamole login page instead.`);
      }
      window.open(res.url, "_blank", "noopener");
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const healthByVm = new Map<string, Array<{ protocol: string; reachable: boolean; authenticated: boolean | null; detail: string }>>();
  for (const h of healthData?.health ?? []) {
    const list = healthByVm.get(h.vmId) ?? [];
    list.push(h);
    healthByVm.set(h.vmId, list);
  }

  const healthDot = (vmId: string | null): ReactNode => {
    if (!vmId) return <span className="text-slate-700">—</span>;
    const entries = healthByVm.get(vmId);
    if (!entries?.length) return <span className="text-slate-700" title="No health data yet">—</span>;
    const bad = entries.filter((e) => !e.reachable || e.authenticated === false);
    const title = entries.map((e) => `${e.protocol.toUpperCase()}: ${e.detail}`).join("\n");
    if (!bad.length) return <span className="text-green-400" title={title}>●</span>;
    return <span className="text-red-400" title={title}>●</span>;
  };

  const toggleSelect = (id: string): void => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const doBulk = async (action: "start" | "stop" | "restart") => {
    setBulkResult(null);
    try {
      const res = await api<{ results: Array<{ vmId: string; ok: boolean; error?: string }> }>("/vms/bulk-action", {
        method: "POST",
        body: { ids: selected, action },
      });
      const failed = res.results.filter((r) => !r.ok);
      setBulkResult(
        failed.length
          ? `${res.results.length - failed.length}/${res.results.length} ${action}ed. Failures: ${failed.map((r) => `${r.vmId.slice(0, 8)} (${r.error})`).join("; ")}`
          : `${res.results.length} VM(s) ${action}ed successfully.`,
      );
      setSelected([]);
      void qc.invalidateQueries({ queryKey: ["vms"] });
    } catch (err) {
      setBulkResult(err instanceof Error ? err.message : String(err));
    }
  };

  const del = (row: VmRow) => {
    confirm(`Delete VM ${row.name} (Proxmox VM ${row.vmid} on ${row.node}) and its Guacamole connection.`, `DELETE ${row.name}`, async () => {
      await api(`/vms/${row.id}`, { method: "DELETE", body: { confirmText: `DELETE ${row.name}` } });
      void qc.invalidateQueries({ queryKey: ["vms"] });
    });
  };

  const btn = "px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40";
  const input = "w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm";
  const label = "block text-xs font-medium text-slate-400 mb-1";

  return (
    <div>
      <PageTitle title="Virtual Machines">
        {canCreate && (
          <button onClick={() => setProvisionOpen(true)} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm">
            Provision VM
          </button>
        )}
      </PageTitle>
      {dialog}
      {data && !data.proxmoxConnected && (
        <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-200 rounded p-3 mb-4 text-sm">
          Proxmox API unreachable — showing stored data only. Error: {data.proxmoxError}
        </div>
      )}

      {canManage && selected.length > 0 && (
        <div className="bg-slate-900 border border-slate-700 rounded p-3 mb-4 text-sm flex flex-wrap items-center gap-2">
          <span className="text-slate-300">{selected.length} selected</span>
          {(["start", "stop", "restart"] as const).map((a) => (
            <button key={a} className={btn} onClick={() => void doBulk(a)}>
              {a.toUpperCase()} ALL
            </button>
          ))}
          <button className="text-xs text-slate-400 underline" onClick={() => setSelected([])}>Clear</button>
        </div>
      )}
      {bulkResult && <div className="bg-slate-900 border border-slate-700 rounded p-3 mb-4 text-sm">{bulkResult}</div>}

      {provisionOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-40 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 w-[40rem] max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Create Virtual Machine</h2>
              <div className="flex rounded overflow-hidden border border-slate-700 text-sm">
                {(["basic", "advanced"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setProvisionMode(m)}
                    className={`px-4 py-1.5 capitalize ${provisionMode === m ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            {!templates?.templates.length ? (
              <div className="text-sm text-amber-300 mb-4">
                No templates registered. Register one on the <Link to="/templates" className="underline">Templates</Link> page first.
              </div>
            ) : provisionMode === "basic" ? (
              <BasicProvisionForm
                basic={basic}
                setBasic={setBasic}
                templates={templates.templates}
                defaults={provisionDefaults ?? null}
                networks={networks?.networks ?? []}
                assignIds={assignIds}
                toggleAssign={toggleAssign}
                users={allUsers?.users ?? null}
                password={generated?.password ?? null}
                onPickTemplate={applyTemplate}
                onSubmit={() => void submitGuarded(provisionBasic)()}
                submitting={submitting}
                onCancel={() => setProvisionOpen(false)}
              />
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={label}>Template</label>
                    <select className={input} value={form.templateId} onChange={(e) => applyTemplate(e.target.value)}>
                      <option value="">Select template…</option>
                      {templates.templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.osType}, {t.node}/{t.proxmoxVmid})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={label}>VM name</label>
                    <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className={label}>Node</label>
                    <select className={input} value={selNode} onChange={(e) => setForm({ ...form, node: e.target.value })}>
                      {(nodes?.nodes ?? []).map((n) => (
                        <option key={n.node} value={n.node}>{n.node} ({n.status})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={label}>VM ID (blank = auto)</label>
                    <input className={input} value={form.vmid} onChange={(e) => setForm({ ...form, vmid: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className={label}>CPU cores</label>
                    <input type="number" className={input} value={form.cpu} onChange={(e) => setForm({ ...form, cpu: Number(e.target.value) })} />
                  </div>
                  <div>
                    <label className={label}>RAM (MB)</label>
                    <input type="number" className={input} value={form.ramMb} onChange={(e) => setForm({ ...form, ramMb: Number(e.target.value) })} />
                  </div>
                  <div>
                    <label className={label}>Disk (GB)</label>
                    <input type="number" className={input} value={form.diskGb} onChange={(e) => setForm({ ...form, diskGb: Number(e.target.value) })} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={label}>Storage</label>
                    <select className={input} value={form.storage} onChange={(e) => setForm({ ...form, storage: e.target.value })}>
                      <option value="">Select storage…</option>
                      {(storage?.storage ?? []).filter((s) => s.content.includes("images")).map((s) => (
                        <option key={s.node + s.storage} value={s.storage}>{s.storage} ({s.type}, node {s.node})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={label}>Network bridge</label>
                    <select className={input} value={form.bridge} onChange={(e) => setForm({ ...form, bridge: e.target.value })}>
                      <option value="">Select bridge…</option>
                      {(networks?.networks ?? []).map((n) => (
                        <option key={n.iface} value={n.iface}>{n.iface} ({n.type})</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className={label}>VLAN tag (0 = none)</label>
                    <input type="number" className={input} value={form.vlan} onChange={(e) => setForm({ ...form, vlan: e.target.value })} />
                  </div>
                  <div>
                    <label className={label}>Network mode</label>
                    <select className={input} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as "dhcp" | "static" })}>
                      <option value="dhcp">DHCP</option>
                      <option value="static">Static</option>
                    </select>
                  </div>
                  {form.mode === "static" && (
                    <div>
                      <label className={label}>IP / gateway</label>
                      <div className="flex gap-1">
                        <input className={input} placeholder="10.0.0.5" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} />
                        <input className={input} placeholder="24" value={form.cidr} onChange={(e) => setForm({ ...form, cidr: e.target.value })} />
                      </div>
                      <input className={`${input} mt-1`} placeholder="Gateway" value={form.gateway} onChange={(e) => setForm({ ...form, gateway: e.target.value })} />
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={label}>Guest username</label>
                    <input className={input} value={form.guestUser} onChange={(e) => setForm({ ...form, guestUser: e.target.value })} />
                  </div>
                  <div>
                    <label className={label}>
                      Guest password (generated & encrypted; never blank)
                      <button type="button" onClick={() => void 0} className="ml-2 underline text-blue-400 text-xs" onClickCapture={() => void 0}>
                        shown below
                      </button>
                    </label>
                    <div className="flex gap-2 items-center">
                      <code className="bg-slate-800 px-2 py-1.5 rounded text-xs flex-1 select-all">{generated?.password ?? "…"}</code>
                    </div>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input type="checkbox" checked={form.linkedClone} onChange={(e) => setForm({ ...form, linkedClone: e.target.checked })} />
                  Linked clone (faster; requires base image on same storage)
                </label>
                <div>
                  <label className={label}>Access protocols (Guacamole)</label>
                  <div className="flex gap-4 text-sm text-slate-300">
                    {["ssh", "rdp", "vnc"].map((p) => (
                      <label key={p} className="flex items-center gap-1 uppercase">
                        <input
                          type="checkbox"
                          checked={form.protocols.includes(p)}
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              protocols: e.target.checked ? [...f.protocols, p] : f.protocols.filter((x) => x !== p),
                            }))
                          }
                        />
                        {p}
                      </label>
                    ))}
                  </div>
                </div>
                <AssignUsersPicker users={allUsers?.users ?? null} assignIds={assignIds} toggleAssign={toggleAssign} />
                <div className="flex justify-end gap-2 mt-4">
                  <button onClick={() => setProvisionOpen(false)} className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded">
                    Cancel
                  </button>
                  <button
                    onClick={() => void submitGuarded(provision)()}
                    disabled={!form.name || !form.templateId || !form.storage || !form.bridge || submitting}
                    className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded"
                  >
                    {submitting ? "Submitting…" : "Start provisioning"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
              {canManage && <th className="py-2 pr-2">✓</th>}
              <th className="py-2">Status</th>
              <th className="py-2">Name</th>
              <th className="py-2">VM ID</th>
              <th className="py-2">OS</th>
              <th className="py-2">Node</th>
              <th className="py-2">IP</th>
              <th className="py-2">CPU</th>
              <th className="py-2">RAM</th>
              <th className="py-2">Disk</th>
              <th className="py-2">Guacamole</th>
              <th className="py-2" title="Last connection health check">Health</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.vms ?? []).map((row) => (
              <tr key={`${row.vmid}@${row.node}`} className="border-b border-slate-800/50 hover:bg-slate-900/50">
                {canManage && (
                  <td className="py-2 pr-2">
                    {row.id ? (
                      <input type="checkbox" checked={selected.includes(row.id)} onChange={() => toggleSelect(row.id as string)} />
                    ) : null}
                  </td>
                )}
                <td className="py-2"><StatusBadge status={row.status} /></td>
                <td>
                  {row.private && <span title="Privacy-flagged: invisible without a direct grant">🔒 </span>}
                  {row.id ? (
                    <Link to={`/vms/${row.id}`} className="text-blue-400 hover:underline">{row.name}</Link>
                  ) : (
                    <span className="text-slate-400">{row.name}</span>
                  )}
                  {!row.tracked && <span className="ml-1 text-xs text-slate-600">(untracked)</span>}
                </td>
                <td className="font-mono">{row.vmid}</td>
                <td>{row.os ?? "Unknown"}</td>
                <td>{row.node}</td>
                <td className="font-mono text-xs">
                  {row.ip ?? (
                    row.id && row.status === "running" && canEdit ? (
                      <button
                        className="text-blue-400 underline text-xs"
                        title="Ask the QEMU Guest Agent for the VM's IP address"
                        onClick={() => void detectIp(row.id as string)}
                      >
                        WAITING FOR GUEST IP — detect
                      </button>
                    ) : (
                      <span className="text-slate-600">WAITING FOR GUEST IP</span>
                    )
                  )}
                </td>
                <td>{row.cpu?.max ? `${row.cpu.max} core${row.cpu.max > 1 ? "s" : ""}` : "—"}</td>
                <td>{fmtBytes(row.mem?.max)}</td>
                <td>{fmtBytes(row.disk?.max)}</td>
                <td>
                  {row.guacamole?.created ? (
                    <StatusBadge status={row.guacamole.status ?? "ACTIVE"} />
                  ) : (
                    <span className="text-xs text-slate-600">none</span>
                  )}
                </td>
                <td>{healthDot(row.id)}</td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {row.id && row.guacamole?.created && canLaunch && (
                      <button
                        className={btn}
                        title={row.guacamole.protocol ? `Launch via ${row.guacamole.protocol.toUpperCase()}` : "Launch"}
                        onClick={() => void launchGuac(row.id as string, row.guacamole?.protocol ?? undefined)}
                      >
                        OPEN GUACAMOLE{row.guacamole.protocol ? ` (${row.guacamole.protocol.toUpperCase()})` : ""}
                      </button>
                    )}
                    {row.id && canManage && (
                      <>
                        <button className={btn} onClick={() => void doAction(row.id as string, "start")}>START</button>
                        <button className={btn} onClick={() => void doAction(row.id as string, "stop")}>STOP</button>
                        <button className={btn} onClick={() => void doAction(row.id as string, "restart")}>RESTART</button>
                      </>
                    )}
                    {row.id && (canEdit || canManage) && (
                      <Link to={`/vms/${row.id}`} className={btn}>EDIT</Link>
                    )}
                    {row.id && canDelete && (
                      <button
                        className={`${btn} text-red-300`}
                        onClick={() =>
                          confirm(
                            `Delete VM ${row.name}?`,
                            `DELETE ${row.name}`,
                            async () => {
                              await api(`/vms/${row.id}`, { method: "DELETE", body: { confirmText: `DELETE ${row.name}` } });
                              void qc.invalidateQueries({ queryKey: ["vms"] });
                            },
                          )
                        }
                      >
                        DELETE
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data?.vms.length && <div className="text-sm text-slate-500 py-4">No VMs found in the Proxmox cluster.</div>}
      </div>
    </div>
  );
}

interface TemplateOption {
  id: string;
  name: string;
  node: string;
  proxmoxVmid: number;
  osType: string;
  defaultCpu: number;
  defaultRamMb: number;
  defaultDiskGb: number;
  supportedProtocols?: string[];
}

interface ProvisionDefaults {
  node: string | null;
  storage: string | null;
  bridge: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  guestUser: string;
  protocols: string[];
  verified: boolean;
  warnings: string[];
}

function Stepper({ label, value, unit, min, max, step, onChange }: {
  label: string; value: number; unit: string; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded p-3">
      <div className="text-xs font-medium text-slate-400 mb-2">{label}</div>
      <div className="flex items-center gap-2">
        <button
          className="w-7 h-7 rounded bg-slate-700 hover:bg-slate-600 text-lg leading-none disabled:opacity-30"
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - step))}
        >
          −
        </button>
        <span className="flex-1 text-center font-mono">
          {value} <span className="text-slate-500 text-xs">{unit}</span>
        </span>
        <button
          className="w-7 h-7 rounded bg-slate-700 hover:bg-slate-600 text-lg leading-none disabled:opacity-30"
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + step))}
        >
          +
        </button>
      </div>
    </div>
  );
}

function AssignUsersPicker({ users, assignIds, toggleAssign }: {
  users: Array<{ id: string; username: string; roles: string[] }> | null;
  assignIds: string[];
  toggleAssign: (id: string) => void;
}) {
  if (!users) return null;
  const grantable = users.filter((u) => !u.roles.includes("ADMIN") && !u.roles.includes("OPERATOR"));
  if (!grantable.length) return null;
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1">
        Users <span className="text-slate-500">(optional — they get this VM + its Guacamole connections)</span>
      </label>
      <div className="max-h-28 overflow-y-auto bg-slate-800/50 border border-slate-700/50 rounded p-2 space-y-1">
        {grantable.map((u) => (
          <label key={u.id} className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
            <input type="checkbox" checked={assignIds.includes(u.id)} onChange={() => toggleAssign(u.id)} />
            {u.username}
          </label>
        ))}
      </div>
    </div>
  );
}

interface BasicState {
  name: string;
  templateId: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  bridge: string;
  protocols: string[];
}

function BasicProvisionForm({ basic, setBasic, templates, defaults, networks, assignIds, toggleAssign, users, password, onPickTemplate, onSubmit, onCancel, submitting }: {
  basic: BasicState;
  setBasic: (b: BasicState) => void;
  templates: TemplateOption[];
  defaults: ProvisionDefaults | null;
  networks: Array<{ iface: string; type: string }>;
  assignIds: string[];
  toggleAssign: (id: string) => void;
  users: Array<{ id: string; username: string; roles: string[] }> | null;
  password: string | null;
  onPickTemplate: (id: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const input = "w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm";
  const label = "block text-xs font-medium text-slate-400 mb-1";
  const tmpl = templates.find((t) => t.id === basic.templateId);
  const supported = tmpl?.supportedProtocols?.length
    ? tmpl.supportedProtocols
    : [tmpl?.osType === "windows" ? "rdp" : "ssh"];
  const bridge = basic.bridge || defaults?.bridge || "vmbr0";
  const bridgeOptions = networks.length ? networks.map((n) => n.iface) : [bridge];
  const memGb = basic.ramMb / 1024;
  const canSubmit =
    basic.name.trim() !== "" &&
    !!basic.templateId &&
    basic.cpu >= 1 && basic.cpu <= 512 &&
    basic.ramMb >= 256 &&
    basic.diskGb >= 1 &&
    basic.protocols.length > 0 &&
    !!password;

  return (
    <div className="space-y-4">
      <div>
        <label className={label}>Name</label>
        <input
          className={input}
          placeholder="Debian Lab"
          value={basic.name}
          onChange={(e) => setBasic({ ...basic, name: e.target.value })}
        />
      </div>
      <div>
        <label className={label}>Template</label>
        <select className={input} value={basic.templateId} onChange={(e) => onPickTemplate(e.target.value)}>
          <option value="">Select template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.osType}, {t.node}/{t.proxmoxVmid})
            </option>
          ))}
        </select>
      </div>
      {defaults && defaults.warnings.length > 0 && (
        <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-200 rounded p-2 text-xs">
          {defaults.warnings.map((w) => <div key={w}>{w}</div>)}
        </div>
      )}
      <div>
        <div className={`${label} mb-2`}>Resources</div>
        <div className="grid grid-cols-3 gap-2">
          <Stepper label="CPU" value={basic.cpu} unit={basic.cpu === 1 ? "core" : "cores"} min={1} max={32} step={1} onChange={(v) => setBasic({ ...basic, cpu: v })} />
          <Stepper label="Memory" value={memGb} unit="GB" min={1} max={128} step={1} onChange={(v) => setBasic({ ...basic, ramMb: v * 1024 })} />
          <Stepper label="Disk" value={basic.diskGb} unit="GB" min={8} max={1024} step={4} onChange={(v) => setBasic({ ...basic, diskGb: v })} />
        </div>
        <div className="text-xs text-slate-500 mt-1">
          Node {defaults?.node ?? "…"} · Storage {defaults?.storage ?? "…"}
          {defaults && !defaults.verified && " (defaults not verified — Proxmox unreachable)"}
        </div>
      </div>
      <div>
        <label className={label}>Network</label>
        <select className={input} value={bridge} onChange={(e) => setBasic({ ...basic, bridge: e.target.value })}>
          {bridgeOptions.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </div>
      <div>
        <label className={label}>Remote Access</label>
        {!basic.templateId ? (
          <div className="text-xs text-slate-500">Select a template to choose protocols.</div>
        ) : (
          <div className="flex gap-4 text-sm text-slate-300">
            {supported.map((p) => (
              <label key={p} className="flex items-center gap-1 uppercase cursor-pointer">
                <input
                  type="checkbox"
                  checked={basic.protocols.includes(p)}
                  onChange={(e) =>
                    setBasic({
                      ...basic,
                      protocols: e.target.checked
                        ? [...basic.protocols, p]
                        : basic.protocols.filter((x) => x !== p),
                    })
                  }
                />
                {p}
              </label>
            ))}
          </div>
        )}
      </div>
      <AssignUsersPicker users={users} assignIds={assignIds} toggleAssign={toggleAssign} />
      <div className="text-xs text-slate-500">
        Guest password (generated & encrypted):{" "}
        <code className="bg-slate-800 px-2 py-1 rounded select-all">{password ?? "…"}</code>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded">
          Cancel
        </button>
        <button
          onClick={onSubmit}
          disabled={!canSubmit || submitting}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded"
        >
          {submitting ? "Creating…" : "Create VM"}
        </button>
      </div>
    </div>
  );
}
