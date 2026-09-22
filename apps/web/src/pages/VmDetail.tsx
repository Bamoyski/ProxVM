import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, explainDenial, jobEventSource } from "../api.js";
import { makeCan, useEffectivePermissions } from "../iam.js";
import { StatusBadge, PageTitle, ErrorBox, useConfirm } from "../components/ui.js";

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

export default function VmDetail({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const { data, error } = useQuery({
    queryKey: ["vm", id],
    queryFn: () => api<Record<string, unknown>>(`/vms/${id}`),
    refetchInterval: 10000,
  });
  const [revealed, setRevealed] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [launchProtocol, setLaunchProtocol] = useState<string | null>(null);
  const [connTest, setConnTest] = useState<Record<string, { testing: boolean; text?: string; ok?: boolean }>>({});
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [cloneTarget, setCloneTarget] = useState("");
  const [migrateTarget, setMigrateTarget] = useState("");
  const [migrateOnline, setMigrateOnline] = useState(true);
  const [templateName, setTemplateName] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [timeframe, setTimeframe] = useState("day");
  const [shareProtocol, setShareProtocol] = useState("");
  const [shareExpiry, setShareExpiry] = useState("60");
  const [shareMaxUses, setShareMaxUses] = useState("");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  // Hooks must run before any early return (Rules of Hooks): permission
  // resolution stays unconditional and only gates rendering below.
  const can = makeCan(useEffectivePermissions(), (perm) => hasPermission(me, perm));
  const canManageEarly = can("vm.manage");
  const canReadNodesEarly = can("proxmox.read");

  const { data: nodesData } = useQuery({
    queryKey: ["proxmox-nodes"],
    queryFn: () => api<{ nodes: Array<{ node: string; status: string }> }>("/proxmox/nodes"),
    enabled: canManageEarly && canReadNodesEarly,
    staleTime: 60000,
  });
  const { data: statsData } = useQuery({
    queryKey: ["vm-stats", id, timeframe],
    queryFn: () => api<{ points: Array<Record<string, unknown>> }>(`/vms/${id}/stats?timeframe=${timeframe}`),
    staleTime: 60000,
  });
  const { data: sharesData } = useQuery({
    queryKey: ["vm-shares", id],
    queryFn: () => api<{ links: Array<{ id: string; vmId: string; protocol: string; expiresAt: string; maxUses: number | null; useCount: number; revokedAt: string | null; createdAt: string }> }>("/share"),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["vm", id] });
  };

  const doAction = async (action: string) => {
    try {
      await api(`/vms/${id}/${action}`, { method: "POST", body: {} });
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const rotate = async () => {
    try {
      const res = await api<{ success: boolean; mechanism: string; verified: boolean; details: string }>(
        `/vms/${id}/credentials/rotate`,
        { method: "POST", body: {} },
      );
      alert(`Password rotated (mechanism: ${res.mechanism}, verified: ${res.verified}). ${res.details}`);
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const reveal = async () => {
    try {
      const res = await api<{ password: string }>(`/vms/${id}/credentials/reveal`, { method: "POST" });
      setRevealed(res.password);
      setTimeout(() => setRevealed(null), 30000);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const copy = async () => {
    try {
      const res = await api<{ password: string }>(`/vms/${id}/credentials/copy`, { method: "POST" });
      await navigator.clipboard.writeText(res.password);
      setRevealed(res.password);
      setTimeout(() => setRevealed(null), 30000);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const launch = async (protocol?: string) => {
    try {
      const res = await api<{ url: string }>(`/vms/${id}/guacamole/launch`, {
        method: "POST",
        body: protocol ? { protocol } : {},
      });
      window.open(res.url, "_blank", "noopener");
    } catch (err) {
      const why = explainDenial(err);
      alert(why ?? (err instanceof Error ? err.message : String(err)));
    }
  };

  const testConnection = async (protocol: string) => {
    setConnTest((t) => ({ ...t, [protocol]: { testing: true } }));
    try {
      const res = await api<{ reachable: boolean; authenticated: boolean | null; detail: string }>(
        `/vms/${id}/guacamole/test`,
        { method: "POST", body: { protocol } },
      );
      const ok = res.reachable && res.authenticated !== false;
      setConnTest((t) => ({
        ...t,
        [protocol]: {
          testing: false,
          ok,
          text: `${res.reachable ? "Reachable" : "Unreachable"}${res.authenticated === null ? "" : res.authenticated ? ", authenticated" : ", NOT authenticated"} — ${res.detail}`,
        },
      }));
    } catch (err) {
      setConnTest((t) => ({
        ...t,
        [protocol]: { testing: false, ok: false, text: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const watchJob = async (jobId: string) => {
    setProgress("Connecting to job stream…");
    jobEventSource(
      jobId,
      (data) => {
        const d = data as { status: string; step: string | null; message: string };
        setProgress(`${d.status}${d.step ? ` (${d.step})` : ""}: ${d.message}`);
      },
      () => setProgress(null),
      (err) => setProgress(`Event stream unavailable: ${err.message}`),
    );
  };

  const del = (vmName: string) => {
    confirm(`Delete VM ${vmName} and all associated resources.`, `DELETE ${vmName}`, async () => {
      await api(`/vms/${id}`, { method: "DELETE", body: { confirmText: `DELETE ${vmName}` } });
      window.location.href = "/vms";
    });
  };

  if (!data) return error ? <ErrorBox error={error} /> : <div className="text-slate-400">Loading…</div>;

  const vm = data.vm as { name: string; vmid: number; node: string; status: string; ip: string | null; osType: string | null };
  const proxmox = data.proxmox as Record<string, unknown> | null;
  const cred = data.credential as Record<string, unknown> | null;
  const guac = data.guacamole as { connections?: Array<{ protocol: string; status: string; port: number; hostname: string; username: string; connectionName: string }>; active?: { protocol: string; status: string; port: number; hostname: string; username: string; connectionName: string } | null } | null;

  const canManage = can("vm.manage");
  const canEdit = can("vm.edit");
  const canDelete = can("vm.delete");
  const canReveal = can("cred.reveal");
  const canRotate = can("cred.rotate");
  const canLaunch = can("guac.launch");
  const canClone = can("vm.create");
  const canTemplate = can("templates.manage");

  const doClone = async () => {
    try {
      const res = await api<{ vm: { id: string; name: string } }>(`/vms/${id}/clone`, {
        method: "POST",
        body: { name: cloneName, target: cloneTarget || undefined },
      });
      alert(`Clone started as ${res.vm.name}.`);
      setCloneOpen(false);
      setCloneName("");
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const doMigrate = async () => {
    try {
      await api(`/vms/${id}/migrate`, { method: "POST", body: { target: migrateTarget, online: migrateOnline } });
      alert(`Migration to ${migrateTarget} started.`);
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const doMakeTemplate = async () => {
    try {
      const res = await api<{ template: { name: string } }>(`/vms/${id}/make-template`, {
        method: "POST",
        body: { name: templateName },
      });
      alert(`Template ${res.template.name} registered.`);
      setTemplateOpen(false);
      setTemplateName("");
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const doShare = async (protocol: string) => {
    try {
      const res = await api<{ token: string }>(`/vms/${id}/share`, {
        method: "POST",
        body: {
          protocol,
          expiresInMinutes: Number(shareExpiry),
          maxUses: shareMaxUses ? Number(shareMaxUses) : undefined,
        },
      });
      setShareUrl(`${window.location.origin}/api/s/${res.token}`);
      void qc.invalidateQueries({ queryKey: ["vm-shares", id] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const doRevokeShare = async (shareId: string) => {
    try {
      await api(`/share/${shareId}`, { method: "DELETE" });
      void qc.invalidateQueries({ queryKey: ["vm-shares", id] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      {dialog}
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link to="/vms" className="text-blue-400 text-sm hover:underline">← Virtual Machines</Link>
          <h1 className="text-2xl font-semibold mt-1">{vm.name} <span className="text-slate-500 text-lg font-mono">({vm.vmid} @ {vm.node})</span></h1>
        </div>
        <div className="flex gap-2">
          {canLaunch && guac?.connections?.length && (
            <div className="flex items-center gap-2">
              <select
                value={launchProtocol ?? ""}
                onChange={(e) => setLaunchProtocol(e.target.value || null)}
                className="px-2 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded"
              >
                <option value="">Select protocol…</option>
                {guac.connections.map((c) => (
                  <option key={c.protocol} value={c.protocol}>{c.protocol.toUpperCase()} ({c.hostname}:{c.port})</option>
                ))}
              </select>
              <button
                onClick={() => void launch(launchProtocol ?? undefined)}
                className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-500 rounded"
                disabled={!launchProtocol}
              >
                Open Guacamole
              </button>
            </div>
          )}
          {canManage && (
            <>
              <button onClick={() => void doAction("start")} className="px-3 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded">Start</button>
              <button onClick={() => void doAction("stop")} className="px-3 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded">Stop</button>
              <button onClick={() => void doAction("restart")} className="px-3 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded">Restart</button>
            </>
          )}
          {canReveal && <button onClick={() => void reveal()} className="px-3 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded">Reveal Credential</button>}
          {canRotate && <button onClick={() => void rotate()} className="px-3 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded">Rotate Password</button>}
          {canDelete && <button onClick={() => del(vm.name)} className="px-3 py-2 text-sm bg-red-800 hover:bg-red-700 rounded">Delete</button>}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 text-sm">
        <Info label="Status"><StatusBadge status={String(proxmox?.status ?? vm.status)} /></Info>
        <Info label="IP"><span className="font-mono">{vm.ip ?? "WAITING FOR GUEST IP"}</span></Info>
        <Info label="CPU cores">{String(proxmox?.cores ?? "—")}</Info>
        <Info label="RAM">{String(proxmox?.memory ?? "—")} MB</Info>
        <Info label="Uptime">{proxmox?.uptime ? `${Math.floor(Number(proxmox.uptime) / 3600)}h ${Math.floor((Number(proxmox.uptime) % 3600) / 60)}m` : "—"}</Info>
        <Info label="Guest agent">{String(proxmox?.agent ?? "—")}</Info>
        <Info label="Guacamole">{guac?.active ? <StatusBadge status={String(guac.active.status)} /> : "not created"}</Info>
        <Info label="Credential status">{cred ? <StatusBadge status={String(cred.status)} /> : "none"}</Info>
      </div>

      {guac?.connections?.length && (
        <div className="bg-slate-900 border border-slate-800 rounded p-4 mb-6">
          <div className="text-sm font-medium text-slate-300 mb-2">Guacamole Connections</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            {guac.connections.map((c) => (
              <div key={c.protocol} className="bg-slate-800 border border-slate-700 rounded p-3">
                <div className="flex justify-between">
                  <span className="font-mono uppercase text-blue-400">{c.protocol}</span>
                  <StatusBadge status={c.status} />
                </div>
                <div className="text-xs text-slate-400 mt-1">{c.hostname}:{c.port}</div>
                <div className="text-xs text-slate-400">User: {c.username}</div>
                {canLaunch && (
                  <div className="mt-2">
                    <button
                      onClick={() => void testConnection(c.protocol)}
                      disabled={connTest[c.protocol]?.testing}
                      className="text-xs text-blue-400 underline disabled:opacity-40 disabled:no-underline"
                    >
                      {connTest[c.protocol]?.testing ? "Testing…" : "Test connection"}
                    </button>
                    {connTest[c.protocol]?.text && (
                      <div className={`text-xs mt-1 ${connTest[c.protocol]?.ok ? "text-green-300" : "text-red-300"}`}>
                        {connTest[c.protocol]?.text}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {(canClone || canTemplate || canManage) && (
        <div className="bg-slate-900 border border-slate-800 rounded p-4 mb-6">
          <div className="text-sm font-medium text-slate-300 mb-3">Clone, migrate & template</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            {canClone && (
              <div>
                <div className="text-xs font-medium text-slate-400 mb-2">Clone this VM</div>
                {!cloneOpen ? (
                  <button onClick={() => { setCloneOpen(true); setCloneName(`${vm.name}-copy`); }} className="px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 rounded">
                    Clone…
                  </button>
                ) : (
                  <div className="space-y-2">
                    <input
                      className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm"
                      placeholder="Clone name"
                      value={cloneName}
                      onChange={(e) => setCloneName(e.target.value)}
                    />
                    {(nodesData?.nodes ?? []).length > 0 && (
                      <select
                        className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm"
                        value={cloneTarget}
                        onChange={(e) => setCloneTarget(e.target.value)}
                      >
                        <option value="">Same node ({vm.node})</option>
                        {(nodesData?.nodes ?? []).filter((n) => n.node !== vm.node).map((n) => (
                          <option key={n.node} value={n.node}>{n.node} ({n.status})</option>
                        ))}
                      </select>
                    )}
                    <div className="flex gap-2">
                      <button onClick={() => void doClone()} disabled={!cloneName.trim()} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded">
                        Clone
                      </button>
                      <button onClick={() => setCloneOpen(false)} className="px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 rounded">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {canManage && (
              <div>
                <div className="text-xs font-medium text-slate-400 mb-2">Migrate to another node</div>
                {(nodesData?.nodes ?? []).filter((n) => n.node !== vm.node).length > 0 ? (
                  <div className="space-y-2">
                    <select
                      className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm"
                      value={migrateTarget}
                      onChange={(e) => setMigrateTarget(e.target.value)}
                    >
                      <option value="">Select target…</option>
                      {(nodesData?.nodes ?? []).filter((n) => n.node !== vm.node).map((n) => (
                        <option key={n.node} value={n.node}>{n.node} ({n.status})</option>
                      ))}
                    </select>
                    <label className="flex items-center gap-2 text-xs text-slate-400">
                      <input type="checkbox" checked={migrateOnline} onChange={(e) => setMigrateOnline(e.target.checked)} />
                      Online migration (running VMs)
                    </label>
                    <button onClick={() => void doMigrate()} disabled={!migrateTarget} className="px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded">
                      Migrate
                    </button>
                  </div>
                ) : (
                  <div className="text-xs text-slate-500">Single-node cluster or node list unavailable.</div>
                )}
              </div>
            )}
            {canTemplate && (
              <div>
                <div className="text-xs font-medium text-slate-400 mb-2">Save as template</div>
                {!templateOpen ? (
                  <button onClick={() => { setTemplateOpen(true); setTemplateName(`${vm.name}-template`); }} className="px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 rounded">
                    New template…
                  </button>
                ) : (
                  <div className="space-y-2">
                    <input
                      className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm"
                      placeholder="Template name"
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                    />
                    <div className="text-xs text-slate-500">The VM must be stopped; Proxmox converts it in place.</div>
                    <div className="flex gap-2">
                      <button onClick={() => void doMakeTemplate()} disabled={!templateName.trim()} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded">
                        Convert
                      </button>
                      <button onClick={() => setTemplateOpen(false)} className="px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 rounded">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <VmGraphs points={statsData?.points ?? []} timeframe={timeframe} setTimeframe={setTimeframe} />

      {canEdit && (
        <VmShareSection
          connections={(guac?.connections ?? []).map((c) => c.protocol)}
          links={(sharesData?.links ?? []).filter((l) => l.vmId === id)}
          shareProtocol={shareProtocol}
          setShareProtocol={setShareProtocol}
          shareExpiry={shareExpiry}
          setShareExpiry={setShareExpiry}
          shareMaxUses={shareMaxUses}
          setShareMaxUses={setShareMaxUses}
          shareUrl={shareUrl}
          onShare={doShare}
          onRevoke={doRevokeShare}
        />
      )}

      {revealed && (
        <div className="bg-slate-800 border border-slate-600 rounded p-3 mb-4 text-sm">
          Credential (auto-hides in 30s): <code className="select-all font-mono text-green-300">{revealed}</code>
          <button onClick={() => void copy()} className="ml-2 text-xs underline">Copy</button>
        </div>
      )}

      {progress && (
        <div className="bg-blue-950 border border-blue-800 text-blue-200 rounded p-3 mb-4 text-sm font-mono">{progress}</div>
      )}

      {canEdit && <UserAccessSection vmId={id} vmName={vm.name} refresh={refresh} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Provisioning history">
          {(data.jobs as Array<Record<string, unknown>>).map((j) => (
            <div key={String(j.id)} className="flex justify-between items-center text-sm py-1 border-b border-slate-800/50">
              <span className="font-mono text-xs">{String(j.id).slice(0, 8)}</span>
              <StatusBadge status={String(j.status)} />
              <button className="text-xs text-blue-400 underline" onClick={() => void watchJob(String(j.id))}>
                Watch
              </button>
              <span className="text-slate-500 text-xs">{new Date(String(j.createdAt)).toLocaleString()}</span>
            </div>
          ))}
        </Section>
        <Section title="Audit history">
          {(data.audit as Array<Record<string, unknown>>).map((a) => (
            <div key={String(a.id)} className="flex justify-between text-sm py-1 text-slate-300">
              <span>{String(a.event)}</span>
              <span className="text-slate-500 text-xs">{String(a.actorUsername ?? "system")} · {new Date(String(a.createdAt)).toLocaleString()}</span>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}

interface AccessUser {
  id: string;
  username: string;
  roles: string[];
  active: boolean;
}

function UserAccessSection({ vmId, vmName, refresh }: { vmId: string; vmName: string; refresh: () => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [usernameInput, setUsernameInput] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  interface AccessEntry {
    user: AccessUser;
    createdAt: string;
    createdBy: string | null;
    protocols: string[] | null;
    expiresAt: string | null;
    source: "direct" | "group";
    groupId: string | null;
    groupName: string | null;
  }

  const [grantProtocols, setGrantProtocols] = useState<string[] | null>(null);
  const [grantExpiry, setGrantExpiry] = useState("");
  const [customExpiry, setCustomExpiry] = useState("");

  const accessQuery = useQuery({
    queryKey: ["vm-access", vmId],
    queryFn: () => api<{ access: AccessEntry[] }>(`/vms/${vmId}/access`),
  });
  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: () => api<{ users: AccessUser[] }>("/users"),
    retry: false,
  });

  const assigned = accessQuery.data?.access ?? [];
  const assignedIds = new Set(assigned.map((a) => a.user.id));
  const allUsers = usersQuery.data?.users ?? [];
  const q = search.trim().toLowerCase();
  const matches = q
    ? allUsers.filter((u) => u.username.toLowerCase().includes(q) && !assignedIds.has(u.id)).slice(0, 8)
    : [];

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["vm-access", vmId] });
    refresh();
  };

  const expiryIso = (): string | undefined => {
    if (!grantExpiry) return undefined;
    if (grantExpiry === "custom") {
      const d = new Date(customExpiry);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    const ms = grantExpiry === "1h" ? 3600_000 : grantExpiry === "1d" ? 86400_000 : 7 * 86400_000;
    return new Date(Date.now() + ms).toISOString();
  };

  const assign = async (who: { userId: string } | { username: string }) => {
    setStatus(null);
    if (grantExpiry === "custom" && !expiryIso()) {
      setStatus({ ok: false, text: "Pick a valid custom expiration date/time." });
      return;
    }
    const body: Record<string, unknown> = { ...who };
    if (grantProtocols !== null) body.protocols = grantProtocols;
    const expiresAt = expiryIso();
    if (expiresAt) body.expiresAt = expiresAt;
    try {
      const res = await api<{ changed: boolean; guacSynced: boolean; protocols: string[] | null; expiresAt: string | null; user: AccessUser }>(
        `/vms/${vmId}/access`,
        { method: "POST", body },
      );
      const protoText = !res.protocols ? "all protocols" : res.protocols.length ? res.protocols.join(", ").toUpperCase() : "no protocols";
      const expText = res.expiresAt ? `, expires ${new Date(res.expiresAt).toLocaleString()}` : "";
      setStatus({
        ok: true,
        text: res.changed
          ? `Granted ${res.user.username} access (${protoText}${expText}).`
          : `${res.user.username} was already assigned; Guacamole permissions re-synced (${protoText}${expText}).`,
      });
      setUsernameInput("");
      setSearch("");
      reload();
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const remove = async (targetUserId: string, targetUsername: string) => {
    setStatus(null);
    try {
      await api(`/vms/${vmId}/access/${targetUserId}`, { method: "DELETE" });
      setStatus({ ok: true, text: `Removed ${targetUsername}'s access (ProxVM + Guacamole).` });
      reload();
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-4 mb-6">
      <div className="text-sm font-medium text-slate-300 mb-1">User Access</div>
      <div className="text-xs text-slate-500 mb-3">
        Assigning a user grants them this VM plus all of its Guacamole connections (SSH/RDP/VNC).
        Removing revokes both.
      </div>
      {status && (
        <div
          className={`rounded p-2 mb-3 text-sm ${status.ok ? "bg-green-900/50 border border-green-700 text-green-200" : "bg-red-900/50 border border-red-700 text-red-200"}`}
        >
          {status.text}
        </div>
      )}
      <div className="space-y-1 mb-3">
        {assigned.map((a) => (
          <div key={`${a.source}-${a.user.id}`} className="flex justify-between items-center text-sm py-1 border-b border-slate-800/50">
            <span>
              <span className="text-green-400 mr-2">✓</span>
              {a.user.username}
              <span className="text-slate-500 text-xs ml-2">
                {a.source === "group" ? `via group ${a.groupName ?? ""} · ` : ""}
                {a.protocols === null ? "all protocols" : a.protocols.length ? a.protocols.join(", ").toUpperCase() : "no protocols"}
                {a.expiresAt ? ` · expires ${new Date(a.expiresAt).toLocaleString()}` : " · never expires"}
              </span>
            </span>
            {a.source === "direct" ? (
              <button
                className="text-xs text-red-300 underline"
                onClick={() => void remove(a.user.id, a.user.username)}
              >
                Remove
              </button>
            ) : (
              <span className="text-xs text-slate-500" title="Group-derived access is managed on the Groups page">managed by group</span>
            )}
          </div>
        ))}
        {!assigned.length && !accessQuery.isLoading && (
          <div className="text-sm text-slate-500">No users assigned to {vmName}.</div>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 items-center text-sm text-slate-300 mb-3">
        <span className="text-xs text-slate-400">Protocols:</span>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={grantProtocols === null}
            onChange={(e) => setGrantProtocols(e.target.checked ? null : ["ssh", "rdp", "vnc"])}
          />
          All
        </label>
        {["ssh", "rdp", "vnc"].map((p) => (
          <label key={p} className="flex items-center gap-1 text-xs uppercase">
            <input
              type="checkbox"
              checked={grantProtocols === null || grantProtocols.includes(p)}
              disabled={grantProtocols === null}
              onChange={(e) =>
                setGrantProtocols((prev) => {
                  const cur = prev ?? ["ssh", "rdp", "vnc"];
                  return e.target.checked ? [...new Set([...cur, p])] : cur.filter((x) => x !== p);
                })
              }
            />
            {p}
          </label>
        ))}
        <span className="text-xs text-slate-400 ml-2">Expires:</span>
        <select
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs"
          value={grantExpiry}
          onChange={(e) => setGrantExpiry(e.target.value)}
        >
          <option value="">Never</option>
          <option value="1h">1 hour</option>
          <option value="1d">1 day</option>
          <option value="1w">1 week</option>
          <option value="custom">Custom…</option>
        </select>
        {grantExpiry === "custom" && (
          <input
            type="datetime-local"
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs"
            value={customExpiry}
            onChange={(e) => setCustomExpiry(e.target.value)}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        {usersQuery.data ? (
          <div className="relative">
            <input
              className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm w-64"
              placeholder="Search users…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {matches.length > 0 && (
              <div className="absolute z-10 mt-1 w-64 bg-slate-800 border border-slate-700 rounded shadow-lg">
                {matches.map((u) => (
                  <button
                    key={u.id}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-700 flex justify-between"
                    onClick={() => void assign({ userId: u.id })}
                  >
                    <span>{u.username}</span>
                    <span className="text-slate-500 text-xs">{u.roles.join(", ")}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <input
            className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm w-64"
            placeholder="Username to assign…"
            value={usernameInput}
            onChange={(e) => setUsernameInput(e.target.value)}
          />
        )}
        {!usersQuery.data && (
          <button
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-40"
            disabled={!usernameInput.trim()}
            onClick={() => void assign({ username: usernameInput.trim() })}
          >
            Assign user
          </button>
        )}
      </div>
      {usersQuery.isError && (
        <div className="text-xs text-slate-500 mt-2">User directory unavailable — assign by exact username.</div>
      )}
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-3">
      <div className="text-xs text-slate-400 mb-1">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-4">
      <div className="text-sm font-medium text-slate-300 mb-2">{title}</div>
      {children}
    </div>
  );
}

const GRAPH_COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#22d3ee"];

function VmGraphs({ points, timeframe, setTimeframe }: {
  points: Array<Record<string, unknown>>;
  timeframe: string;
  setTimeframe: (t: string) => void;
}) {
  const series = (() => {
    if (!points.length) return [];
    const keys = Object.keys(points[0] ?? {}).filter((k) => k !== "time" && typeof points[0]?.[k] === "number");
    return keys.slice(0, 6).map((key, i) => {
      const values = points.map((p) => Number(p[key] ?? 0));
      const max = Math.max(1, ...values);
      const coords = values.map((v, j) => {
        const x = points.length < 2 ? 0 : (j / (points.length - 1)) * 560;
        const y = 140 - (v / max) * 130;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      return { key, color: GRAPH_COLORS[i % GRAPH_COLORS.length]!, max, last: values[values.length - 1] ?? 0, coords: coords.join(" ") };
    });
  })();
  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-4 mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-slate-300">Resource graphs</div>
        <select
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs"
          value={timeframe}
          onChange={(e) => setTimeframe(e.target.value)}
        >
          {["hour", "day", "week", "month"].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>
      {!series.length ? (
        <div className="text-xs text-slate-500">No data points yet for this range.</div>
      ) : (
        <>
          <svg viewBox="0 0 560 150" className="w-full h-36 bg-slate-950 border border-slate-800 rounded">
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1="0" x2="560" y1={150 * f} y2={150 * f} stroke="#1e293b" strokeWidth="1" />
            ))}
            {series.map((s) => (
              <polyline key={s.key} points={s.coords} fill="none" stroke={s.color} strokeWidth="1.5" />
            ))}
          </svg>
          <div className="flex flex-wrap gap-3 mt-2 text-xs">
            {series.map((s) => (
              <span key={s.key} className="text-slate-400">
                <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: s.color }} />
                <span className="font-mono">{s.key}</span>: {s.last.toFixed(s.max < 10 ? 3 : 1)}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface ShareLinkRow {
  id: string;
  vmId: string;
  protocol: string;
  expiresAt: string;
  maxUses: number | null;
  useCount: number;
  revokedAt: string | null;
  createdAt: string;
}

function VmShareSection({ connections, links, shareProtocol, setShareProtocol, shareExpiry, setShareExpiry, shareMaxUses, setShareMaxUses, shareUrl, onShare, onRevoke }: {
  connections: string[];
  links: ShareLinkRow[];
  shareProtocol: string;
  setShareProtocol: (v: string) => void;
  shareExpiry: string;
  setShareExpiry: (v: string) => void;
  shareMaxUses: string;
  setShareMaxUses: (v: string) => void;
  shareUrl: string | null;
  onShare: (protocol: string) => void;
  onRevoke: (shareId: string) => void;
}) {
  const active = links.filter((l) => !l.revokedAt && new Date(l.expiresAt).getTime() > Date.now());
  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-4 mb-6">
      <div className="text-sm font-medium text-slate-300 mb-1">Shareable session links</div>
      <div className="text-xs text-slate-500 mb-3">
        Time-boxed links anyone can open — no account needed. Opening mints a fresh Guacamole session
        under your identity; revoke anytime to kill them instantly.
      </div>
      <div className="flex flex-wrap gap-2 items-center mb-3">
        <select
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm"
          value={shareProtocol}
          onChange={(e) => setShareProtocol(e.target.value)}
        >
          <option value="">Select protocol…</option>
          {connections.map((p) => (
            <option key={p} value={p}>{p.toUpperCase()}</option>
          ))}
        </select>
        <select
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm"
          value={shareExpiry}
          onChange={(e) => setShareExpiry(e.target.value)}
          title="Link lifetime"
        >
          <option value="60">1 hour</option>
          <option value="1440">1 day</option>
          <option value="10080">7 days</option>
        </select>
        <input
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm w-28"
          placeholder="Max uses (∞)"
          inputMode="numeric"
          value={shareMaxUses}
          onChange={(e) => setShareMaxUses(e.target.value.replace(/[^0-9]/g, ""))}
        />
        <button
          onClick={() => shareProtocol && onShare(shareProtocol)}
          disabled={!shareProtocol}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded"
        >
          Create link
        </button>
      </div>
      {shareUrl && (
        <div className="bg-slate-800 border border-slate-700 rounded p-3 mb-3 text-sm">
          <div className="text-xs text-slate-400 mb-1">Share this URL (shown once — copy it now):</div>
          <code className="select-all font-mono text-xs text-green-300 break-all">{shareUrl}</code>
        </div>
      )}
      {active.length > 0 ? (
        <div className="space-y-1">
          {active.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-2 text-xs py-1 border-b border-slate-800/50">
              <span className="font-mono uppercase text-blue-300">{l.protocol}</span>
              <span className="text-slate-400">expires {new Date(l.expiresAt).toLocaleString()}</span>
              <span className="text-slate-400">used {l.useCount}{l.maxUses === null ? "" : `/${l.maxUses}`}</span>
              <button onClick={() => onRevoke(l.id)} className="text-red-300 underline ml-auto">Revoke</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-slate-500">No active share links for this VM.</div>
      )}
    </div>
  );
}
