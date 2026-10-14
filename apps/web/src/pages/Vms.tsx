import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { savePref, usePref } from "../prefs.js";
import { makeCan, useEffectivePermissions } from "../iam.js";
import { StatusBadge, PageTitle, ErrorBox, Empty, Section, Btn, useConfirm } from "../components/ui.js";
import Templates from "./Templates.js";

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
  isolated?: boolean;
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
  // Templates live here as a tab (not a separate page): the provision flow
  // already picks from the same template registry.
  const canTemplates = can("templates.manage");
  const [params, setParams] = useSearchParams();
  const view = params.get("tab") === "templates" && canTemplates ? "templates" : "vms";
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
  const [grantUserId, setGrantUserId] = useState("");
  const [granting, setGranting] = useState(false);
  const [search, setSearch] = usePref("vms-search", "");
  const [statusFilter, setStatusFilter] = usePref("vms-status", "all");
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
  // Remember last-used infrastructure choices (never name/password/address).
  // Loaded once when the dialog opens; saved on every change below.
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    if (!provisionOpen || prefsLoaded) return;
    setPrefsLoaded(true);
    try {
      const raw = window.localStorage.getItem("proxvm-pref:vms-provision");
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<typeof form>;
      setForm((f) => ({
        ...f,
        node: typeof saved.node === "string" ? saved.node : f.node,
        storage: typeof saved.storage === "string" ? saved.storage : f.storage,
        bridge: typeof saved.bridge === "string" ? saved.bridge : f.bridge,
        cpu: typeof saved.cpu === "number" ? saved.cpu : f.cpu,
        ramMb: typeof saved.ramMb === "number" ? saved.ramMb : f.ramMb,
        diskGb: typeof saved.diskGb === "number" ? saved.diskGb : f.diskGb,
      }));
    } catch {
      // corrupted prefs: start fresh
    }
  }, [provisionOpen, prefsLoaded]);
  useEffect(() => {
    if (!provisionOpen) return;
    savePref("vms-provision", {
      node: form.node,
      storage: form.storage,
      bridge: form.bridge,
      cpu: form.cpu,
      ramMb: form.ramMb,
      diskGb: form.diskGb,
    });
  }, [provisionOpen, form.node, form.storage, form.bridge, form.cpu, form.ramMb, form.diskGb]);
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
  // Bulk access grants need the user directory too (admin-only endpoint;
  // operators without users.manage simply don't get the picker).
  const { data: grantUsers } = useQuery({
    queryKey: ["users-grant"],
    queryFn: () => api<{ users: Array<{ id: string; username: string; roles: string[] }> }>("/users"),
    enabled: canEdit,
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
    const dot = (color: string, title?: string) => (
      <span style={{ color, fontSize: "0.7rem", lineHeight: 1 }} title={title}>●</span>
    );
    if (!vmId) return <span style={{ color: "var(--pv-text-3)" }}>—</span>;
    const entries = healthByVm.get(vmId);
    if (!entries?.length) return <span style={{ color: "var(--pv-text-3)" }} title="No health data yet">—</span>;
    const bad = entries.filter((e) => !e.reachable || e.authenticated === false);
    const title = entries.map((e) => `${e.protocol.toUpperCase()}: ${e.detail}`).join("\n");
    if (!bad.length) return dot("var(--pv-ok)", title);
    return dot("var(--pv-err)", title);
  };

  const toggleSelect = (id: string): void => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const doBulk = async (action: "start" | "stop" | "restart") => {    setBulkResult(null);
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

  // Bulk access grant: same managed endpoint as the per-VM picker, looped
  // per selected VM with per-VM results (one failure never aborts the rest).
  const doBulkGrant = async () => {
    if (!grantUserId || granting) return;
    setGranting(true);
    setBulkResult(null);
    try {
      let ok = 0;
      const failed: string[] = [];
      for (const vmId of selected) {
        try {
          await api(`/vms/${vmId}/access`, { method: "POST", body: { userId: grantUserId } });
          ok += 1;
        } catch (err) {
          failed.push(`${vmId.slice(0, 8)} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      setBulkResult(
        failed.length
          ? `${ok}/${ok + failed.length} granted. Failures: ${failed.join("; ")}`
          : `${ok} VM(s) granted successfully.`,
      );
      setSelected([]);
      setGrantUserId("");
    } finally {
      setGranting(false);
    }
  };

  const visibleRows = (data?.vms ?? []).filter((row) => {
    if (statusFilter !== "all" && row.status !== statusFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      row.name.toLowerCase().includes(q) ||
      row.node.toLowerCase().includes(q) ||
      String(row.vmid).includes(q) ||
      (row.ip ?? "").toLowerCase().includes(q)
    );
  });

  const del = (row: VmRow) => {
    confirm(`Delete VM ${row.name} (Proxmox VM ${row.vmid} on ${row.node}) and its Guacamole connection.`, `DELETE ${row.name}`, async () => {
      await api(`/vms/${row.id}`, { method: "DELETE", body: { confirmText: `DELETE ${row.name}` } });
      void qc.invalidateQueries({ queryKey: ["vms"] });
    });
  };

  return (
    <div className="pv-page">
      <PageTitle title="Virtual Machines" description="Every VM in the cluster. Select rows for bulk power actions.">
        {canCreate && (
          <Btn kind="primary" onClick={() => setProvisionOpen(true)}>
            Provision VM
          </Btn>
        )}
      </PageTitle>
      {dialog}
      {data && !data.proxmoxConnected && view === "vms" && (
        <div className="pv-notice pv-notice-warn">
          Proxmox API unreachable — showing stored data only. Error: {data.proxmoxError}
        </div>
      )}

      {canTemplates && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }} role="tablist" aria-label="Virtual machines views">
          <button
            role="tab"
            aria-selected={view === "vms"}
            onClick={() => setParams({})}
            className={view === "vms" ? "pv-btn pv-btn-primary pv-btn-sm" : "pv-btn pv-btn-sm"}
          >
            Virtual machines
          </button>
          <button
            role="tab"
            aria-selected={view === "templates"}
            onClick={() => setParams({ tab: "templates" })}
            className={view === "templates" ? "pv-btn pv-btn-primary pv-btn-sm" : "pv-btn pv-btn-sm"}
          >
            Templates
          </button>
        </div>
      )}
      {view === "templates" ? (
        <Templates />
      ) : (
      <>
      {canManage && selected.length > 0 && (
        <div className="pv-notice" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <span>{selected.length} selected</span>
          {(["start", "stop", "restart"] as const).map((a) => (
            <Btn key={a} size="sm" onClick={() => void doBulk(a)}>
              {a[0]!.toUpperCase() + a.slice(1)} all
            </Btn>
          ))}
          <Btn size="sm" kind="link" onClick={() => setSelected([])}>Clear</Btn>
        </div>
      )}
      {canEdit && selected.length > 0 && (grantUsers?.users?.length ?? 0) > 0 && (
        <div className="pv-notice" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <span>Grant access to {selected.length} selected:</span>
          <select className="pv-select" style={{ fontSize: "0.8rem" }} value={grantUserId} onChange={(e) => setGrantUserId(e.target.value)} aria-label="User to grant">
            <option value="">Select user…</option>
            {(grantUsers?.users ?? [])
              .filter((u) => !u.roles.includes("ADMIN") && !u.roles.includes("OPERATOR"))
              .map((u) => (
                <option key={u.id} value={u.id}>{u.username}</option>
              ))}
          </select>
          <Btn size="sm" kind="primary" disabled={!grantUserId || granting} onClick={() => void doBulkGrant()}>
            {granting ? "Granting…" : "Grant"}
          </Btn>
        </div>
      )}
      {bulkResult && <div className="pv-notice">{bulkResult}</div>}

      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <input
          className="pv-input"
          style={{ maxWidth: 280 }}
          placeholder="Search name, node, IP, ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search VMs"
        />
        <select className="pv-select" style={{ maxWidth: 160 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="all">All statuses</option>
          <option value="running">Running</option>
          <option value="stopped">Stopped</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {provisionOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-40 p-4">
          <div className="pv-panel" style={{ width: "40rem", maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <h2 className="pv-title" style={{ fontSize: "1.05rem" }}>Provision virtual machine</h2>
              <div style={{ display: "flex", border: "1px solid var(--pv-border)", borderRadius: 6, overflow: "hidden", fontSize: "0.8rem" }}>
                {(["basic", "advanced"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setProvisionMode(m)}
                    style={{
                      padding: "6px 14px", textTransform: "capitalize", cursor: "pointer", border: "none",
                      background: provisionMode === m ? "var(--pv-accent)" : "transparent",
                      color: provisionMode === m ? "var(--pv-accent-ink)" : "var(--pv-text-2)",
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            {!templates?.templates.length ? (
              <div className="pv-notice pv-notice-warn">
                No templates registered. Register one on the <Link to="/vms?tab=templates">Templates</Link> tab first.
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
              <div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="pv-field">
                    <label className="pv-label">Template</label>
                    <select className="pv-select" value={form.templateId} onChange={(e) => applyTemplate(e.target.value)}>
                      <option value="">Select template…</option>
                      {templates.templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.osType}, {t.node}/{t.proxmoxVmid})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="pv-field">
                    <label className="pv-label">VM name</label>
                    <input className="pv-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="pv-field">
                    <label className="pv-label">Node</label>
                    <select className="pv-select" value={selNode} onChange={(e) => setForm({ ...form, node: e.target.value })}>
                      {(nodes?.nodes ?? []).map((n) => (
                        <option key={n.node} value={n.node}>{n.node} ({n.status})</option>
                      ))}
                    </select>
                  </div>
                  <div className="pv-field">
                    <label className="pv-label">VM ID (blank = auto)</label>
                    <input className="pv-input" value={form.vmid} onChange={(e) => setForm({ ...form, vmid: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="pv-field">
                    <label className="pv-label">CPU cores</label>
                    <input type="number" className="pv-input" value={form.cpu} onChange={(e) => setForm({ ...form, cpu: Number(e.target.value) })} />
                  </div>
                  <div className="pv-field">
                    <label className="pv-label">RAM (MB)</label>
                    <input type="number" className="pv-input" value={form.ramMb} onChange={(e) => setForm({ ...form, ramMb: Number(e.target.value) })} />
                  </div>
                  <div className="pv-field">
                    <label className="pv-label">Disk (GB)</label>
                    <input type="number" className="pv-input" value={form.diskGb} onChange={(e) => setForm({ ...form, diskGb: Number(e.target.value) })} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="pv-field">
                    <label className="pv-label">Storage</label>
                    <select className="pv-select" value={form.storage} onChange={(e) => setForm({ ...form, storage: e.target.value })}>
                      <option value="">Select storage…</option>
                      {(storage?.storage ?? []).filter((s) => s.content.includes("images")).map((s) => (
                        <option key={s.node + s.storage} value={s.storage}>{s.storage} ({s.type}, node {s.node})</option>
                      ))}
                    </select>
                  </div>
                  <div className="pv-field">
                    <label className="pv-label">Network bridge</label>
                    <select className="pv-select" value={form.bridge} onChange={(e) => setForm({ ...form, bridge: e.target.value })}>
                      <option value="">Select bridge…</option>
                      {(networks?.networks ?? []).map((n) => (
                        <option key={n.iface} value={n.iface}>{n.iface} ({n.type})</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="pv-field">
                    <label className="pv-label">VLAN tag (0 = none)</label>
                    <input type="number" className="pv-input" value={form.vlan} onChange={(e) => setForm({ ...form, vlan: e.target.value })} />
                  </div>
                  <div className="pv-field">
                    <label className="pv-label">Network mode</label>
                    <select className="pv-select" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as "dhcp" | "static" })}>
                      <option value="dhcp">DHCP</option>
                      <option value="static">Static</option>
                    </select>
                  </div>
                  {form.mode === "static" && (
                    <div className="pv-field">
                      <label className="pv-label">IP / gateway</label>
                      <div className="flex gap-1">
                        <input className="pv-input" placeholder="10.0.0.5" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} />
                        <input className="pv-input" placeholder="24" value={form.cidr} onChange={(e) => setForm({ ...form, cidr: e.target.value })} />
                      </div>
                      <input className="pv-input" style={{ marginTop: 4 }} placeholder="Gateway" value={form.gateway} onChange={(e) => setForm({ ...form, gateway: e.target.value })} />
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="pv-field">
                    <label className="pv-label">Guest username</label>
                    <input className="pv-input" value={form.guestUser} onChange={(e) => setForm({ ...form, guestUser: e.target.value })} />
                  </div>
                  <div className="pv-field">
                    <label className="pv-label">Guest password (generated, encrypted)</label>
                    <code className="pv-mono" style={{ display: "block", background: "var(--pv-inset)", border: "1px solid var(--pv-border)", borderRadius: 6, padding: "8px 10px", userSelect: "all" }}>{generated?.password ?? "…"}</code>
                  </div>
                </div>
                <label className="pv-checkrow" style={{ marginBottom: 12 }}>
                  <input type="checkbox" checked={form.linkedClone} onChange={(e) => setForm({ ...form, linkedClone: e.target.checked })} />
                  Linked clone (faster; requires base image on same storage)
                </label>
                <div className="pv-field">
                  <label className="pv-label">Access protocols (Guacamole)</label>
                  <div style={{ display: "flex", gap: 16 }}>
                    {["ssh", "rdp", "vnc"].map((p) => (
                      <label key={p} className="pv-checkrow" style={{ textTransform: "uppercase" }}>
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
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                  <Btn onClick={() => setProvisionOpen(false)}>Cancel</Btn>
                  <Btn
                    kind="primary"
                    onClick={() => void submitGuarded(provision)()}
                    disabled={!form.name || !form.templateId || !form.storage || !form.bridge || submitting}
                  >
                    {submitting ? "Submitting…" : "Start provisioning"}
                  </Btn>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="pv-table-wrap">
        <table className="pv-table">
          <thead>
            <tr>
              {canManage && <th><span className="pv-mono">✓</span></th>}
              <th>Status</th>
              <th>Name</th>
              <th>VM ID</th>
              <th>OS</th>
              <th>Node</th>
              <th>IP</th>
              <th className="num">CPU</th>
              <th className="num">RAM</th>
              <th className="num">Disk</th>
              <th>Guacamole</th>
              <th title="Last connection health check">Health</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={`${row.vmid}@${row.node}`}>
                {canManage && (
                  <td>
                    {row.id ? (
                      <input type="checkbox" checked={selected.includes(row.id)} onChange={() => toggleSelect(row.id as string)} />
                    ) : null}
                  </td>
                )}
                <td><StatusBadge status={row.status} /></td>
                <td>
                  {row.id ? (
                    <Link to={`/vms/${row.id}`}>{row.name}</Link>
                  ) : (
                    <span style={{ color: "var(--pv-text-3)" }}>{row.name}</span>
                  )}
                  {row.private && <span className="pv-mono" title="Privacy-flagged: invisible without a direct grant" style={{ marginLeft: 6, color: "var(--pv-text-3)" }}>private</span>}
                  {row.isolated && <span className="pv-mono" title="Network-isolated: default-deny firewall, explicit allows only" style={{ marginLeft: 6, color: "var(--pv-text-3)" }}>isolated</span>}
                  {!row.tracked && <span className="pv-mono" style={{ marginLeft: 6, color: "var(--pv-text-3)" }}>untracked</span>}
                </td>
                <td className="pv-mono">{row.vmid}</td>
                <td>{row.os ?? "Unknown"}</td>
                <td>{row.node}</td>
                <td className="pv-mono">
                  {row.ip ?? (
                    row.id && row.status === "running" && canEdit ? (
                      <Btn
                        kind="link"
                        title="Ask the QEMU Guest Agent for the VM's IP address"
                        onClick={() => void detectIp(row.id as string)}
                      >
                        Detect IP
                      </Btn>
                    ) : (
                      <span style={{ color: "var(--pv-text-3)" }}>—</span>
                    )
                  )}
                </td>
                <td className="num">{row.cpu?.max ? `${row.cpu.max}c` : "—"}</td>
                <td className="num">{fmtBytes(row.mem?.max)}</td>
                <td className="num">{fmtBytes(row.disk?.max)}</td>
                <td>
                  {row.guacamole?.created ? (
                    <StatusBadge status={row.guacamole.status ?? "ACTIVE"} />
                  ) : (
                    <span style={{ color: "var(--pv-text-3)" }}>—</span>
                  )}
                </td>
                <td>{healthDot(row.id)}</td>
                <td>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {row.id && row.guacamole?.created && canLaunch && (
                      <Btn
                        size="sm"
                        title={row.guacamole.protocol ? `Launch via ${row.guacamole.protocol.toUpperCase()}` : "Launch"}
                        onClick={() => void launchGuac(row.id as string, row.guacamole?.protocol ?? undefined)}
                      >
                        Open{row.guacamole.protocol ? ` ${row.guacamole.protocol.toUpperCase()}` : ""}
                      </Btn>
                    )}
                    {row.id && canManage && (
                      <>
                        <Btn size="sm" onClick={() => void doAction(row.id as string, "start")}>Start</Btn>
                        <Btn size="sm" onClick={() => void doAction(row.id as string, "stop")}>Stop</Btn>
                        <Btn size="sm" onClick={() => void doAction(row.id as string, "restart")}>Restart</Btn>
                      </>
                    )}
                    {row.id && (canEdit || canManage) && (
                      <Link to={`/vms/${row.id}`} className="pv-btn pv-btn-sm">Open</Link>
                    )}
                    {row.id && canDelete && (
                      <Btn
                        size="sm"
                        kind="link"
                        onClick={() =>
                          del({
                            ...row,
                            id: row.id,
                          })
                        }
                      >
                        Delete
                      </Btn>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data?.vms.length && view === "vms" && (
        <Empty
          title="No virtual machines"
          body="Nothing in the Proxmox cluster is visible to you yet. Provision one, or ask an administrator for access."
          action={canCreate ? <Btn kind="primary" size="sm" onClick={() => setProvisionOpen(true)}>Provision VM</Btn> : undefined}
        />
      )}
      </>
      )}
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
    <div style={{ background: "var(--pv-inset)", border: "1px solid var(--pv-border-soft)", borderRadius: 6, padding: 10 }}>
      <div className="pv-label" style={{ marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Btn size="sm" disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}>
          −
        </Btn>
        <span className="pv-mono" style={{ flex: 1, textAlign: "center" }}>
          {value} <span style={{ color: "var(--pv-text-3)" }}>{unit}</span>
        </span>
        <Btn size="sm" disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}>
          +
        </Btn>
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
    <div className="pv-field">
      <label className="pv-label">
        Users <span style={{ fontWeight: 400 }}>(optional — they get this VM + its Guacamole connections)</span>
      </label>
      <div style={{ maxHeight: 112, overflowY: "auto", background: "var(--pv-inset)", border: "1px solid var(--pv-border-soft)", borderRadius: 6, padding: 8 }}>
        {grantable.map((u) => (
          <label key={u.id} className="pv-checkrow" style={{ padding: "3px 0", cursor: "pointer" }}>
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
    <div>
      <div className="pv-field">
        <label className="pv-label">Name</label>
        <input
          className="pv-input"
          placeholder="Debian Lab"
          value={basic.name}
          onChange={(e) => setBasic({ ...basic, name: e.target.value })}
        />
      </div>
      <div className="pv-field">
        <label className="pv-label">Template</label>
        <select className="pv-select" value={basic.templateId} onChange={(e) => onPickTemplate(e.target.value)}>
          <option value="">Select template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.osType}, {t.node}/{t.proxmoxVmid})
            </option>
          ))}
        </select>
      </div>
      {defaults && defaults.warnings.length > 0 && (
        <div className="pv-notice pv-notice-warn" style={{ fontSize: "0.78rem" }}>
          {defaults.warnings.map((w) => <div key={w}>{w}</div>)}
        </div>
      )}
      <div className="pv-field">
        <div className="pv-label" style={{ marginBottom: 8 }}>Resources</div>
        <div className="grid grid-cols-3 gap-2">
          <Stepper label="CPU" value={basic.cpu} unit={basic.cpu === 1 ? "core" : "cores"} min={1} max={32} step={1} onChange={(v) => setBasic({ ...basic, cpu: v })} />
          <Stepper label="Memory" value={memGb} unit="GB" min={1} max={128} step={1} onChange={(v) => setBasic({ ...basic, ramMb: v * 1024 })} />
          <Stepper label="Disk" value={basic.diskGb} unit="GB" min={8} max={1024} step={4} onChange={(v) => setBasic({ ...basic, diskGb: v })} />
        </div>
        <div className="pv-hint">
          Node {defaults?.node ?? "…"} · Storage {defaults?.storage ?? "…"}
          {defaults && !defaults.verified && " (defaults not verified — Proxmox unreachable)"}
        </div>
      </div>
      <div className="pv-field">
        <label className="pv-label">Network</label>
        <select className="pv-select" value={bridge} onChange={(e) => setBasic({ ...basic, bridge: e.target.value })}>
          {bridgeOptions.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </div>
      <div className="pv-field">
        <label className="pv-label">Remote access</label>
        {!basic.templateId ? (
          <div className="pv-hint">Select a template to choose protocols.</div>
        ) : (
          <div style={{ display: "flex", gap: 16 }}>
            {supported.map((p) => (
              <label key={p} className="pv-checkrow" style={{ textTransform: "uppercase", cursor: "pointer" }}>
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
      <div className="pv-hint" style={{ marginBottom: 12 }}>
        Guest password (generated &amp; encrypted):{" "}
        <code className="pv-mono" style={{ userSelect: "all" }}>{password ?? "…"}</code>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn kind="primary" onClick={onSubmit} disabled={!canSubmit || submitting}>
          {submitting ? "Creating…" : "Create VM"}
        </Btn>
      </div>
    </div>
  );
}
