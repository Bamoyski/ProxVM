import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  MonitorUp,
  MoreHorizontal,
  Play,
  RotateCw,
  Square,
  Trash2,
  Search,
  Server,
  Eye,
  Pencil,
  ScanSearch,
} from "lucide-react";
import { api, explainDenial } from "../api.js";
import { usePref } from "../prefs.js";
import { makeCan, useEffectivePermissions } from "../iam.js";
import { hasPermission, type Me } from "../lib/permissions.js";
import { fmtBytes, fmtUptime } from "../lib/format.js";
import type { VmRow } from "../lib/vm.js";
import {
  PageHeader, Btn, StatusBadge, Badge, EmptyState, TableSkeleton,
  Alert, Menu, useConfirm, useToast, errText, Select, Tooltip,
} from "../ui/index.js";
import Templates from "./Templates.js";
import ProvisionWizard from "./ProvisionWizard.js";

type SortKey = "name" | "status" | "node" | "vmid" | "cpu" | "mem" | "disk" | "uptime";

const SORT_LABEL: Record<SortKey, string> = {
  name: "Name",
  status: "Status",
  node: "Node",
  vmid: "VM ID",
  cpu: "CPU",
  mem: "Memory",
  disk: "Disk",
  uptime: "Uptime",
};

export default function Vms({ me }: { me: Me }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const can = makeCan(useEffectivePermissions(), (perm) => hasPermission(me, perm));
  const canCreate = can("vm.create");
  const canManage = can("vm.manage");
  const canEdit = can("vm.edit");
  const canDelete = can("vm.delete");
  const canLaunch = can("guac.launch");
  const canTemplates = can("templates.manage");

  const [params, setParams] = useSearchParams();
  const view = params.get("tab") === "templates" && canTemplates ? "templates" : "vms";

  const { data, error, isLoading } = useQuery({
    queryKey: ["vms"],
    queryFn: () => api<{ vms: VmRow[]; proxmoxConnected: boolean; proxmoxError: string | null }>("/vms"),
    refetchInterval: 10000,
  });
  const { data: healthData } = useQuery({
    queryKey: ["connection-health"],
    queryFn: () =>
      api<{ health: Array<{ vmId: string; protocol: string; reachable: boolean; authenticated: boolean | null; detail: string }> }>(
        "/connection-health",
      ),
    refetchInterval: 60000,
  });
  const { data: grantUsers } = useQuery({
    queryKey: ["users-grant"],
    queryFn: () => api<{ users: Array<{ id: string; username: string; roles: string[] }> }>("/users"),
    enabled: canEdit,
    retry: false,
  });

  const [search, setSearch] = usePref("vms-search", "");
  const [statusFilter, setStatusFilter] = usePref("vms-status", "all");
  const [sort, setSort] = usePref("vms-sort", { key: "name" as SortKey, dir: "asc" as "asc" | "desc" });
  const [selected, setSelected] = useState<string[]>([]);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [grantUserId, setGrantUserId] = useState("");
  const [granting, setGranting] = useState(false);
  const [actionVm, setActionVm] = useState<string | null>(null);

  /* ------------------------------ derived ----------------------------- */

  const healthByVm = useMemo(() => {
    const map = new Map<string, Array<{ protocol: string; reachable: boolean; authenticated: boolean | null; detail: string }>>();
    for (const h of healthData?.health ?? []) {
      const list = map.get(h.vmId) ?? [];
      list.push(h);
      map.set(h.vmId, list);
    }
    return map;
  }, [healthData]);

  const rows = useMemo(() => {
    const list = (data?.vms ?? []).filter((row) => {
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
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (r: VmRow): string | number => {
      switch (sort.key) {
        case "name": return r.name.toLowerCase();
        case "status": return r.status;
        case "node": return r.node.toLowerCase();
        case "vmid": return r.vmid;
        case "cpu": return r.cpu?.max ?? -1;
        case "mem": return r.mem?.max ?? -1;
        case "disk": return r.disk?.max ?? -1;
        case "uptime": return r.uptime ?? -1;
      }
    };
    return [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.vmid - b.vmid;
    });
  }, [data, search, statusFilter, sort]);

  const allVisibleSelected = rows.length > 0 && rows.every((r) => r.id && selected.includes(r.id));

  /* ------------------------------ actions ----------------------------- */

  const doAction = async (id: string, name: string, action: "start" | "stop" | "restart") => {
    setActionVm(id);
    try {
      await api(`/vms/${id}/${action}`, { method: "POST", body: {} });
      toast.info(`${action[0]!.toUpperCase()}${action.slice(1)} requested`, `${name} — the change applies once Proxmox finishes.`);
      void qc.invalidateQueries({ queryKey: ["vms"] });
      void qc.invalidateQueries({ queryKey: ["vm", id] });
    } catch (err) {
      toast.err(`${action[0]!.toUpperCase()}${action.slice(1)} failed`, explainDenial(err) ?? errText(err));
    } finally {
      setActionVm(null);
    }
  };

  const detectIp = async (id: string, name: string) => {
    try {
      const res = await api<{ detected: boolean; ip?: string; reason?: string }>(`/vms/${id}/detect-ip`, { method: "POST" });
      if (res.detected) toast.ok("IP detected", `${name}: ${res.ip}`);
      else toast.warn("IP not detected", res.reason ?? "The guest agent did not report an address.");
      void qc.invalidateQueries({ queryKey: ["vms"] });
    } catch (err) {
      toast.err("IP detection failed", errText(err));
    }
  };

  const launchGuac = async (id: string, name: string, protocol?: string) => {
    try {
      const res = await api<{ url: string; mode?: string; detail?: string }>(`/vms/${id}/guacamole/launch`, {
        method: "POST",
        body: protocol ? { protocol } : {},
      });
      if (res.mode === "login") {
        toast.warn("Direct session unavailable", `${res.detail ?? "Falling back to the Guacamole login page."}`);
      }
      window.open(res.url, "_blank", "noopener");
    } catch (err) {
      toast.err("Could not open console", explainDenial(err) ?? errText(err));
    }
  };

  const del = async (row: VmRow) => {
    const ok = await confirm({
      title: `Delete ${row.name}?`,
      danger: true,
      requireText: `DELETE ${row.name}`,
      confirmLabel: "Delete VM",
      body: (
        <>
          Deletes Proxmox VM <b>{row.vmid}</b> on <b>{row.node}</b>, its Guacamole connection, and its
          stored credential. This cannot be undone.
        </>
      ),
    });
    if (!ok || !row.id) return;
    try {
      await api(`/vms/${row.id}`, { method: "DELETE", body: { confirmText: `DELETE ${row.name}` } });
      toast.ok("VM deleted", `${row.name} removed from Proxmox and ProxVM.`);
      void qc.invalidateQueries({ queryKey: ["vms"] });
    } catch (err) {
      toast.err("Delete failed", errText(err));
    }
  };

  const doBulk = async (action: "start" | "stop" | "restart") => {
    const count = selected.length;
    if (action !== "start") {
      const ok = await confirm({
        title: `${action === "stop" ? "Stop" : "Restart"} ${count} VM(s)?`,
        danger: action === "stop",
        confirmLabel: `${action === "stop" ? "Stop" : "Restart"} all`,
        body: `Runs ${action} on each selected VM. Guests get the ACPI signal — unsaved work inside them may be lost.`,
      });
      if (!ok) return;
    }
    try {
      const res = await api<{ results: Array<{ vmId: string; ok: boolean; error?: string }> }>("/vms/bulk-action", {
        method: "POST",
        body: { ids: selected, action },
      });
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length) {
        toast.warn(
          `${res.results.length - failed.length}/${res.results.length} ${action}ed`,
          `Failures: ${failed.map((r) => `${r.vmId.slice(0, 8)} (${r.error})`).join("; ")}`,
        );
      } else {
        toast.ok(`${res.results.length} VM(s) ${action}ed`);
      }
      setSelected([]);
      void qc.invalidateQueries({ queryKey: ["vms"] });
    } catch (err) {
      toast.err(`Bulk ${action} failed`, errText(err));
    }
  };

  // Bulk access grant: same managed endpoint as the per-VM picker, looped
  // per selected VM with per-VM results (one failure never aborts the rest).
  const doBulkGrant = async () => {
    if (!grantUserId || granting) return;
    setGranting(true);
    try {
      let ok = 0;
      const failed: string[] = [];
      for (const vmId of selected) {
        try {
          await api(`/vms/${vmId}/access`, { method: "POST", body: { userId: grantUserId } });
          ok += 1;
        } catch (err) {
          failed.push(`${vmId.slice(0, 8)} (${errText(err)})`);
        }
      }
      if (failed.length) toast.warn(`${ok}/${ok + failed.length} granted`, failed.join("; "));
      else toast.ok(`${ok} VM(s) granted`);
      setSelected([]);
      setGrantUserId("");
      void qc.invalidateQueries({ queryKey: ["vms"] });
    } finally {
      setGranting(false);
    }
  };

  const toggleSelect = (id: string): void =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const toggleSort = (key: SortKey): void =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  /* ------------------------------- render ----------------------------- */

  if (view === "templates") {
    return (
      <div className="pv-page">
        <PageHeader
          title="Templates"
          description="Base VM images registered with ProxVM. Provisioning clones from these."
          actions={
            <Btn size="sm" onClick={() => setParams({})}>← Back to VMs</Btn>
          }
        />
        <Templates />
      </div>
    );
  }

  const grantable = (grantUsers?.users ?? []).filter(
    (u) => !u.roles.includes("ADMIN") && !u.roles.includes("OPERATOR"),
  );

  return (
    <div className="pv-page">
      <PageHeader
        title="Virtual machines"
        description="Every VM visible to you across the cluster. Select rows for bulk power actions."
        actions={
          <>
            {canTemplates && (
              <Btn onClick={() => setParams({ tab: "templates" })}>Templates</Btn>
            )}
            {canCreate && (
              <Btn kind="primary" onClick={() => setProvisionOpen(true)}>
                Provision VM
              </Btn>
            )}
          </>
        }
      />

      {data && !data.proxmoxConnected && (
        <Alert kind="warn" title="Proxmox API unreachable">
          Showing stored data only. Last error: {data.proxmoxError}
        </Alert>
      )}

      <div className="pv-toolbar">
        <div className="pv-search">
          <Search size={13} className="pv-search-ico" aria-hidden="true" />
          <input
            className="pv-input"
            placeholder="Search name, node, IP, ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search VMs"
          />
        </div>
        <Select
          autoWidth
          small
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="running">Running</option>
          <option value="stopped">Stopped</option>
          <option value="failed">Failed</option>
        </Select>
        {(search || statusFilter !== "all") && (
          <Btn size="sm" kind="ghost" onClick={() => { setSearch(""); setStatusFilter("all"); }}>
            Clear filters
          </Btn>
        )}
        <span className="pv-faint" style={{ fontSize: "0.78rem", marginLeft: "auto" }}>
          {rows.length} of {data?.vms.length ?? 0} VMs
        </span>
      </div>

      {selected.length > 0 && (
        <div className="pv-selbar" role="region" aria-label="Bulk actions">
          <span className="pv-selbar-count">{selected.length} selected</span>
          {canManage && (
            <>
              <span className="pv-selbar-sep" aria-hidden="true" />
              <Btn size="sm" disabled={actionVm !== null} onClick={() => void doBulk("start")}>
                <Play size={12} aria-hidden="true" /> Start all
              </Btn>
              <Btn size="sm" disabled={actionVm !== null} onClick={() => void doBulk("stop")}>
                <Square size={12} aria-hidden="true" /> Stop all
              </Btn>
              <Btn size="sm" disabled={actionVm !== null} onClick={() => void doBulk("restart")}>
                <RotateCw size={12} aria-hidden="true" /> Restart all
              </Btn>
            </>
          )}
          {canEdit && grantable.length > 0 && (
            <>
              <span className="pv-selbar-sep" aria-hidden="true" />
              <span className="pv-faint" style={{ fontSize: "0.8rem" }}>Grant access to</span>
              <Select
                autoWidth
                small
                value={grantUserId}
                onChange={(e) => setGrantUserId(e.target.value)}
                aria-label="User to grant access to"
              >
                <option value="">Select user…</option>
                {grantable.map((u) => (
                  <option key={u.id} value={u.id}>{u.username}</option>
                ))}
              </Select>
              <Btn size="sm" kind="primary" disabled={!grantUserId || granting} onClick={() => void doBulkGrant()}>
                {granting ? "Granting…" : "Grant"}
              </Btn>
            </>
          )}
          <span style={{ marginLeft: "auto" }}>
            <Btn size="sm" kind="ghost" onClick={() => setSelected([])}>Clear selection</Btn>
          </span>
        </div>
      )}

      {isLoading && !data ? (
        <div className="pv-table-wrap"><TableSkeleton rows={6} cols={8} /></div>
      ) : error ? (
        <Alert kind="err" title="Failed to load VMs">{errText(error)}</Alert>
      ) : (
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>
                {canManage && (
                  <th style={{ width: 34 }}>
                    <label className="pv-check-target">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={(e) =>
                          setSelected(e.target.checked ? rows.map((r) => r.id).filter((x): x is string => !!x) : [])
                        }
                        aria-label={allVisibleSelected ? "Deselect all visible VMs" : "Select all visible VMs"}
                      />
                    </label>
                  </th>
                )}
                <SortTh k="status" sort={sort} onSort={toggleSort}>Status</SortTh>
                <SortTh k="name" sort={sort} onSort={toggleSort}>Name</SortTh>
                <SortTh k="vmid" sort={sort} onSort={toggleSort}>ID</SortTh>
                <th className="pv-hide-sm">OS</th>
                <SortTh k="node" sort={sort} onSort={toggleSort}>Node</SortTh>
                <th>IP</th>
                <SortTh k="cpu" sort={sort} onSort={toggleSort} numeric>CPU</SortTh>
                <SortTh k="mem" sort={sort} onSort={toggleSort} numeric>RAM</SortTh>
                <SortTh k="disk" sort={sort} onSort={toggleSort} numeric className="pv-hide-md">Disk</SortTh>
                <SortTh k="uptime" sort={sort} onSort={toggleSort} className="pv-hide-md">Uptime</SortTh>
                <th className="pv-hide-md" title="Last connection health check">Health</th>
                <th style={{ width: 40 }}><span className="pv-sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.vmid}@${row.node}`} className={row.id && selected.includes(row.id) ? "pv-row-selected" : undefined}>
                  {canManage && (
                    <td>
                      {row.id ? (
                        <label className="pv-check-target">
                          <input
                            type="checkbox"
                            checked={selected.includes(row.id)}
                            onChange={() => toggleSelect(row.id as string)}
                            aria-label={`Select ${row.name}`}
                          />
                        </label>
                      ) : null}
                    </td>
                  )}
                  <td>
                    <StatusBadge status={row.status} label={row.status} animate={row.status === "starting" || row.status === "stopping"} />
                  </td>
                  <td style={{ maxWidth: 260 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      {row.id ? (
                        <Link to={`/vms/${row.id}`} style={{ fontWeight: 550 }} className="pv-truncate pv-link-target">
                          {row.name}
                        </Link>
                      ) : (
                        <span className="pv-truncate" style={{ color: "var(--pv-text-3)" }}>{row.name}</span>
                      )}
                      {row.private && (
                        <Badge tone="plain" icon={<Eye size={10} aria-hidden="true" />}>private</Badge>
                      )}
                      {row.isolated && (
                        <Badge tone="plain">isolated</Badge>
                      )}
                      {!row.tracked && (
                        <Badge tone="plain">untracked</Badge>
                      )}
                    </div>
                  </td>
                  <td className="pv-mono">{row.vmid}</td>
                  <td className="pv-hide-sm pv-truncate" style={{ maxWidth: 160 }}>{row.os ?? "Unknown"}</td>
                  <td>{row.node}</td>
                  <td className="pv-mono">
                    {row.ip ?? (
                      row.id && row.status === "running" && canEdit ? (
                        <button
                          className="pv-btn pv-btn-link"
                          title="Ask the QEMU Guest Agent for the VM's IP address"
                          onClick={() => void detectIp(row.id as string, row.name)}
                        >
                          Detect IP
                        </button>
                      ) : (
                        <span className="pv-faint">—</span>
                      )
                    )}
                  </td>
                  <td className="num">{row.cpu?.max ? `${row.cpu.max}c` : "—"}</td>
                  <td className="num">{fmtBytes(row.mem?.max)}</td>
                  <td className="num pv-hide-md">{fmtBytes(row.disk?.max)}</td>
                  <td className="pv-hide-md">{fmtUptime(row.uptime)}</td>
                  <td className="pv-hide-md"><HealthDot vmId={row.id} healthByVm={healthByVm} /></td>
                  <td>
                    <Menu
                      label={`Actions for ${row.name}`}
                      trigger={({ open, toggle, ref }) => (
                        <button
                          ref={ref}
                          className="pv-btn pv-btn-ghost pv-btn-icon pv-btn-sm"
                          aria-expanded={open}
                          aria-label={`Actions for ${row.name}`}
                          onClick={toggle}
                        >
                          <MoreHorizontal size={14} aria-hidden="true" />
                        </button>
                      )}
                      items={[
                        ...(row.id && row.guacamole?.created && canLaunch
                          ? [{
                              label: `Open console${row.guacamole.protocol ? ` (${row.guacamole.protocol.toUpperCase()})` : ""}`,
                              icon: <MonitorUp size={13} aria-hidden="true" />,
                              onSelect: () => void launchGuac(row.id as string, row.name, row.guacamole?.protocol ?? undefined),
                            }]
                          : []),
                        ...(row.id && canManage
                          ? [
                              {
                                label: "Start",
                                icon: <Play size={13} aria-hidden="true" />,
                                disabled: row.status === "running" || actionVm === row.id,
                                onSelect: () => void doAction(row.id as string, row.name, "start"),
                              },
                              {
                                label: "Stop",
                                icon: <Square size={13} aria-hidden="true" />,
                                disabled: row.status === "stopped" || actionVm === row.id,
                                onSelect: () => void doAction(row.id as string, row.name, "stop"),
                              },
                              {
                                label: "Restart",
                                icon: <RotateCw size={13} aria-hidden="true" />,
                                disabled: row.status !== "running" || actionVm === row.id,
                                onSelect: () => void doAction(row.id as string, row.name, "restart"),
                              },
                            ]
                          : []),
                        ...(row.id && (canEdit || canManage)
                          ? [{
                              label: "Open details",
                              icon: <Pencil size={13} aria-hidden="true" />,
                              onSelect: () => {
                                window.location.href = `/vms/${row.id}`;
                              },
                            }]
                          : []),
                        ...(row.id && row.status === "running" && !row.ip && canEdit
                          ? [{
                              label: "Detect IP",
                              icon: <ScanSearch size={13} aria-hidden="true" />,
                              onSelect: () => void detectIp(row.id as string, row.name),
                            }]
                          : []),
                        ...(row.id && canDelete
                          ? [{
                              label: "Delete…",
                              icon: <Trash2 size={13} aria-hidden="true" />,
                              danger: true,
                              onSelect: () => void del(row),
                            }]
                          : []),
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && !error && data && !data.vms.length && (
        <EmptyState
          icon={<Server size={26} aria-hidden="true" />}
          title="No virtual machines"
          body="Nothing in the Proxmox cluster is visible to you yet. Provision one, or ask an administrator for access."
          action={
            canCreate ? (
              <Btn kind="primary" size="sm" onClick={() => setProvisionOpen(true)}>Provision VM</Btn>
            ) : undefined
          }
        />
      )}
      {!isLoading && !error && data && data.vms.length > 0 && rows.length === 0 && (
        <EmptyState
          title="No VMs match the current filters"
          body="Try a different search term or clear the status filter."
          action={
            <Btn size="sm" onClick={() => { setSearch(""); setStatusFilter("all"); }}>Clear filters</Btn>
          }
        />
      )}

      {provisionOpen && <ProvisionWizard onClose={() => setProvisionOpen(false)} />}
    </div>
  );
}

/* ============================== sub-parts ============================= */

function SortTh({
  k,
  sort,
  onSort,
  numeric,
  className,
  children,
}: {
  k: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
  numeric?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const active = sort.key === k;
  return (
    <th className={className} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button
        className={`pv-th-sort${active ? " pv-th-sort-active" : ""}`}
        style={numeric ? { marginLeft: "auto", display: "flex" } : undefined}
        onClick={() => onSort(k)}
      >
        {children}
        {active ? (
          sort.dir === "asc" ? (
            <ArrowUp size={11} className="pv-th-sort-ico" aria-hidden="true" />
          ) : (
            <ArrowDown size={11} className="pv-th-sort-ico" aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown size={11} className="pv-th-sort-ico" aria-hidden="true" />
        )}
      </button>
      <span className="pv-sr-only">{SORT_LABEL[k]}</span>
    </th>
  );
}

function HealthDot({
  vmId,
  healthByVm,
}: {
  vmId: string | null;
  healthByVm: Map<string, Array<{ protocol: string; reachable: boolean; authenticated: boolean | null; detail: string }>>;
}) {
  if (!vmId) return <span className="pv-faint">—</span>;
  const entries = healthByVm.get(vmId);
  if (!entries?.length) {
    return (
      <Tooltip content="No health data yet">
        <span className="pv-faint">—</span>
      </Tooltip>
    );
  }
  const bad = entries.filter((e) => !e.reachable || e.authenticated === false);
  const detail = entries.map((e) => `${e.protocol.toUpperCase()}: ${e.detail}`).join("\n");
  return (
    <Tooltip content={detail}>
      <span
        role="img"
        aria-label={bad.length ? "Connection problem detected" : "All connections reachable"}
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: 999,
          background: bad.length ? "var(--pv-err)" : "var(--pv-ok)",
        }}
      />
    </Tooltip>
  );
}
