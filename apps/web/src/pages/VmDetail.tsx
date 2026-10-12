import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, explainDenial, jobEventSource } from "../api.js";
import { makeCan, useEffectivePermissions } from "../iam.js";
import { StatusBadge, PageTitle, ErrorBox, Section, Empty, Btn, useConfirm } from "../components/ui.js";
import VmFirewallSection from "./VmFirewallSection.js";

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
  // Async migration: POST /migrate returns 202 immediately (long migrations
  // exceed Cloudflare's 100s proxy timeout), then we poll until Proxmox
  // reports the task stopped. Survives nothing on unmount — polling simply
  // stops; the migration continues server-side and the next poll finalizes.
  const [migrating, setMigrating] = useState<{
    target: string;
    upid: string;
    online: boolean;
    detachedIso: string[];
    startedAt: number;
  } | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [timeframe, setTimeframe] = useState("day");
  const [shareProtocol, setShareProtocol] = useState("");
  const [shareExpiry, setShareExpiry] = useState("60");
  const [shareMaxUses, setShareMaxUses] = useState("");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [inviteUser, setInviteUser] = useState("");
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

  // Hooks must run before any early return (Rules of Hooks): this effect is
  // a no-op until a migration starts (migrating === null), so it is safe —
  // and required — to register it unconditionally on every render.
  useEffect(() => {
    if (!migrating) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const deadline = migrating.startedAt + 40 * 60 * 1000;
    const tick = async () => {
      if (cancelled) return;
      try {
        const qs = new URLSearchParams({
          upid: migrating.upid,
          target: migrating.target,
          online: String(migrating.online),
          detachedIso: migrating.detachedIso.join(","),
        });
        const st = await api<{ state: string; exitStatus?: string }>(`/vms/${id}/migration?${qs.toString()}`);
        if (cancelled) return;
        if (st.state === "done") {
          setMigrating(null);
          alert(`Migration to ${migrating.target} complete.`);
          void qc.invalidateQueries({ queryKey: ["vm", id] });
          return;
        }
        if (st.state === "error") {
          setMigrating(null);
          alert(
            `Migration to ${migrating.target} failed: ${st.exitStatus ?? "unknown error"}. The VM is still on its source node.`,
          );
          void qc.invalidateQueries({ queryKey: ["vm", id] });
          return;
        }
        failures = 0;
        if (Date.now() > deadline) {
          setMigrating(null);
          alert("Migration is still running but status polling timed out — it continues server-side; reload this page to check.");
          return;
        }
        timer = setTimeout(() => void tick(), 5000);
      } catch {
        // Transient blips (proxy hiccups) shouldn't kill the poll; give up
        // only after repeated consecutive failures.
        failures += 1;
        if (failures >= 5) {
          if (!cancelled) {
            setMigrating(null);
            alert("Lost contact with the migration status check — the migration may still be running server-side; reload this page to check.");
          }
          return;
        }
        timer = setTimeout(() => void tick(), 5000);
      }
    };
    timer = setTimeout(() => void tick(), 3000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // qc is context-stable; refresh is deliberately excluded (recreated per
    // render and would restart polling every render).
  }, [migrating, id, qc]);

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

  if (!data) return error ? <ErrorBox error={error} /> : <div style={{ color: "var(--pv-text-3)" }}>Loading…</div>;

  const vm = data.vm as { name: string; vmid: number; node: string; status: string; ip: string | null; osType: string | null; private?: boolean; viewerAccess?: boolean; vmClass?: string; startOnBoot?: boolean };
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
      const res = await api<{ accepted: boolean; upid: string; detachedIso: string[] }>(`/vms/${id}/migrate`, {
        method: "POST",
        body: { target: migrateTarget, online: migrateOnline },
      });
      setMigrating({
        target: migrateTarget,
        upid: res.upid,
        online: migrateOnline,
        detachedIso: res.detachedIso ?? [],
        startedAt: Date.now(),
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const doInvite = async () => {
    try {
      await api(`/vms/${id}/invite`, { method: "POST", body: { username: inviteUser.trim() } });
      alert(`${inviteUser.trim()} now has access.`);
      setInviteUser("");
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const togglePrivacy = async () => {
    try {
      const res = await api<{ private: boolean }>(`/vms/${id}/privacy`, {
        method: "PATCH",
        body: { enabled: !vm.private },
      });
      alert(res.private ? "Privacy flag on — only granted users can see this VM now." : "Privacy flag off.");
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const setStartOnBoot = async (enabled: boolean) => {
    try {
      await api(`/vms/${id}/start-on-boot`, { method: "PATCH", body: { enabled } });
      alert(
        enabled
          ? "Start on host boot is on — Proxmox will power this VM on automatically when its node boots."
          : "Start on host boot is off — this VM stays stopped across node reboots.",
      );
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const setClass = async (vmClass: "server" | "user") => {
    try {
      await api(`/vms/${id}/class`, { method: "PATCH", body: { vmClass } });
      alert(
        vmClass === "user"
          ? "Marked as a user VM — eligible for idle auto-shutdown when the global switch is on."
          : "Marked as a server VM — never auto-shut down.",
      );
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
    <div className="pv-page">
      {dialog}
      <div style={{ marginBottom: 4 }}>
        <Link to="/vms" style={{ fontSize: "0.8rem" }}>← Virtual Machines</Link>
      </div>
      <div className="pv-title-row" style={{ marginBottom: 14 }}>
        <h1 className="pv-title">
          {vm.name}{" "}
          <span className="pv-mono" style={{ color: "var(--pv-text-3)", fontWeight: 400 }}>
            {vm.vmid} @ {vm.node}
          </span>
          {vm.private && <span className="pv-mono" title="Privacy-flagged: invisible without a direct grant" style={{ marginLeft: 8, color: "var(--pv-text-3)" }}>private</span>}
        </h1>
        <div className="pv-title-actions">
          {canLaunch && guac?.connections?.length && (
            <>
              <select
                value={launchProtocol ?? ""}
                onChange={(e) => setLaunchProtocol(e.target.value || null)}
                className="pv-select pv-input-auto"
                style={{ height: 32 }}
                aria-label="Protocol"
              >
                <option value="">Protocol…</option>
                {guac.connections.map((c) => (
                  <option key={c.protocol} value={c.protocol}>{c.protocol.toUpperCase()} ({c.hostname}:{c.port})</option>
                ))}
              </select>
              <Btn kind="primary" onClick={() => void launch(launchProtocol ?? undefined)} disabled={!launchProtocol}>
                Open
              </Btn>
            </>
          )}
          {canManage && (
            <>
              <Btn onClick={() => void doAction("start")}>Start</Btn>
              <Btn onClick={() => void doAction("stop")}>Stop</Btn>
              <Btn onClick={() => void doAction("restart")}>Restart</Btn>
            </>
          )}
          {canReveal && <Btn onClick={() => void reveal()}>Reveal credential</Btn>}
          {canRotate && <Btn onClick={() => void rotate()}>Rotate password</Btn>}
          {canDelete && <Btn kind="link" onClick={() => del(vm.name)}>Delete</Btn>}
        </div>
      </div>

      <dl className="pv-kv pv-kv-3" style={{ marginBottom: 24 }}>
        <dt>Status</dt><dd><StatusBadge status={String(proxmox?.status ?? vm.status)} /></dd>
        <dt>IP</dt><dd><span className="pv-mono">{vm.ip ?? "—"}</span></dd>
        <dt>CPUs</dt><dd>{String(proxmox?.cores ?? "—")}</dd>
        <dt>Memory</dt><dd>{proxmox?.memory ? `${proxmox.memory} MB` : "—"}</dd>
        <dt>Uptime</dt><dd>{proxmox?.uptime ? `${Math.floor(Number(proxmox.uptime) / 3600)}h ${Math.floor((Number(proxmox.uptime) % 3600) / 60)}m` : "—"}</dd>
        <dt>Guest agent</dt><dd>{String(proxmox?.agent ?? "—")}</dd>
        <dt>Guacamole</dt><dd>{guac?.active ? <StatusBadge status={String(guac.active.status)} /> : "not created"}</dd>
        <dt>Credential</dt><dd>{cred ? <StatusBadge status={String(cred.status)} /> : "none"}{cred?.username ? ` · ${String(cred.username)}` : ""}</dd>
      </dl>

      {guac?.connections?.length && (
        <Section title="Remote connections" hint={`${guac.connections.length} protocol${guac.connections.length > 1 ? "s" : ""} via Guacamole`}>
          <div className="pv-table-wrap">
            <table className="pv-table">
              <thead>
                <tr><th>Protocol</th><th>Status</th><th>Target</th><th>User</th>{canLaunch && <th>Check</th>}</tr>
              </thead>
              <tbody>
                {guac.connections.map((c) => (
                  <tr key={c.protocol}>
                    <td className="pv-mono" style={{ textTransform: "uppercase" }}>{c.protocol}</td>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="pv-mono">{c.hostname}:{c.port}</td>
                    <td>{c.username}</td>
                    {canLaunch && (
                      <td>
                        <Btn
                          size="sm"
                          kind="link"
                          onClick={() => void testConnection(c.protocol)}
                          disabled={connTest[c.protocol]?.testing}
                        >
                          {connTest[c.protocol]?.testing ? "Testing…" : "Test"}
                        </Btn>
                        {connTest[c.protocol]?.text && (
                          <div style={{ fontSize: "0.76rem", marginTop: 2, color: connTest[c.protocol]?.ok ? "var(--pv-ok)" : "var(--pv-err)" }}>
                            {connTest[c.protocol]?.text}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {(canClone || canTemplate || canManage || canEdit) && (
        <Section title="Manage" hint="Clone, migrate, template, privacy, class">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-4 text-sm">
            {canClone && (
              <div>
                <div className="pv-label">Clone this VM</div>
                {!cloneOpen ? (
                  <Btn size="sm" onClick={() => { setCloneOpen(true); setCloneName(`${vm.name}-copy`); }}>
                    Clone…
                  </Btn>
                ) : (
                  <div>
                    <input
                      className="pv-input"
                      style={{ marginBottom: 8 }}
                      placeholder="Clone name"
                      value={cloneName}
                      onChange={(e) => setCloneName(e.target.value)}
                    />
                    {(nodesData?.nodes ?? []).length > 0 && (
                      <select
                        className="pv-select"
                        style={{ marginBottom: 8 }}
                        value={cloneTarget}
                        onChange={(e) => setCloneTarget(e.target.value)}
                      >
                        <option value="">Same node ({vm.node})</option>
                        {(nodesData?.nodes ?? []).filter((n) => n.node !== vm.node).map((n) => (
                          <option key={n.node} value={n.node}>{n.node} ({n.status})</option>
                        ))}
                      </select>
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      <Btn size="sm" kind="primary" onClick={() => void doClone()} disabled={!cloneName.trim()}>
                        Clone
                      </Btn>
                      <Btn size="sm" onClick={() => setCloneOpen(false)}>
                        Cancel
                      </Btn>
                    </div>
                  </div>
                )}
              </div>
            )}
            {canManage && (
              <div>
                <div className="pv-label">Migrate to another node</div>
                {(nodesData?.nodes ?? []).filter((n) => n.node !== vm.node).length > 0 ? (
                  <div>
                    <select
                      className="pv-select"
                      style={{ marginBottom: 8 }}
                      value={migrateTarget}
                      onChange={(e) => setMigrateTarget(e.target.value)}
                    >
                      <option value="">Select target…</option>
                      {(nodesData?.nodes ?? []).filter((n) => n.node !== vm.node).map((n) => (
                        <option key={n.node} value={n.node}>{n.node} ({n.status})</option>
                      ))}
                    </select>
                    <label className="pv-checkrow" style={{ marginBottom: 8 }}>
                      <input type="checkbox" checked={migrateOnline} onChange={(e) => setMigrateOnline(e.target.checked)} />
                      Online migration (running VMs)
                    </label>
                    <button onClick={() => void doMigrate()} disabled={!migrateTarget || migrating !== null} className="px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded">
                      {migrating ? `Migrating to ${migrating.target}…` : "Migrate"}
                    </button>
                    {migrating && (
                      <div className="text-xs text-slate-400">Migration running — checking status every few seconds. Safe to leave this page.</div>
                    )}
                  </div>
                ) : (
                  <div className="pv-hint">Single-node cluster or node list unavailable.</div>
                )}
              </div>
            )}
            {canTemplate && (
              <div>
                <div className="pv-label">Save as template</div>
                {!templateOpen ? (
                  <Btn size="sm" onClick={() => { setTemplateOpen(true); setTemplateName(`${vm.name}-template`); }}>
                    New template…
                  </Btn>
                ) : (
                  <div>
                    <input
                      className="pv-input"
                      style={{ marginBottom: 8 }}
                      placeholder="Template name"
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                    />
                    <div className="pv-hint" style={{ marginBottom: 8 }}>The VM must be stopped; Proxmox converts it in place.</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Btn size="sm" kind="primary" onClick={() => void doMakeTemplate()} disabled={!templateName.trim()}>
                        Convert
                      </Btn>
                      <Btn size="sm" onClick={() => setTemplateOpen(false)}>
                        Cancel
                      </Btn>
                    </div>
                  </div>
                )}
              </div>
            )}
            {(vm.viewerAccess || !vm.private || me.roles.includes("ADMIN")) && (
              <div>
                <div className="pv-label">Privacy</div>
                <div className="pv-hint" style={{ marginBottom: 8 }}>
                  {vm.private
                    ? "On — invisible to everyone without a direct grant, including administrators."
                    : "Off — administrators can see and manage this VM without a grant."}
                </div>
                <Btn size="sm" onClick={() => void togglePrivacy()}>
                  Turn {vm.private ? "off" : "on"}
                </Btn>
              </div>
            )}
            {canEdit && (
              <div>
                <div className="pv-label">Start on host boot</div>
                <div className="pv-hint" style={{ marginBottom: 8 }}>
                  {vm.startOnBoot
                    ? "On — Proxmox powers this VM on automatically when its node boots."
                    : "Off — this VM stays stopped across node reboots."}
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                  <Btn size="sm" onClick={() => void setStartOnBoot(true)} disabled={vm.startOnBoot === true}>
                    On
                  </Btn>
                  <Btn size="sm" onClick={() => void setStartOnBoot(false)} disabled={!vm.startOnBoot}>
                    Off
                  </Btn>
                </div>
                <div className="pv-label">VM class</div>
                <div className="pv-hint" style={{ marginBottom: 8 }}>
                  {(vm.vmClass ?? "server") === "user"
                    ? "User VM — eligible for idle auto-shutdown when the global switch is on."
                    : "Server VM — never auto-shut down."}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn
                    size="sm"
                    onClick={() => void setClass("server")}
                    disabled={(vm.vmClass ?? "server") === "server"}
                  >
                    Server
                  </Btn>
                  <Btn
                    size="sm"
                    onClick={() => void setClass("user")}
                    disabled={vm.vmClass === "user"}
                  >
                    User
                  </Btn>
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {vm.viewerAccess && (
        <Section
          title="Invite someone"
          hint="Anyone with access can bring one more person in — including an administrator on a privacy-flagged VM."
        >
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="pv-input"
              style={{ width: 224 }}
              placeholder="Username to invite…"
              value={inviteUser}
              onChange={(e) => setInviteUser(e.target.value)}
            />
            <Btn kind="primary" onClick={() => void doInvite()} disabled={!inviteUser.trim()}>
              Invite
            </Btn>
          </div>
        </Section>
      )}

      <VmGraphs points={statsData?.points ?? []} timeframe={timeframe} setTimeframe={setTimeframe} />

      {canEdit && <VmFirewallSection vmId={id} />}

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
        <div className="pv-notice pv-notice-ok" style={{ fontSize: "0.85rem" }}>
          Credential (auto-hides in 30s): <code className="pv-mono" style={{ userSelect: "all" }}>{revealed}</code>{" "}
          <Btn size="sm" kind="link" onClick={() => void copy()}>Copy</Btn>
        </div>
      )}

      {progress && (
        <div className="pv-notice pv-mono" style={{ fontSize: "0.8rem" }}>{progress}</div>
      )}

      {canEdit && <UserAccessSection vmId={id} vmName={vm.name} refresh={refresh} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-10">
        <Section title="Provisioning history">
          {(data.jobs as Array<Record<string, unknown>>).map((j) => (
            <div key={String(j.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
              <span className="pv-mono">{String(j.id).slice(0, 8)}</span>
              <StatusBadge status={String(j.status)} />
              <Btn size="sm" kind="link" onClick={() => void watchJob(String(j.id))}>
                Watch
              </Btn>
              <span style={{ marginLeft: "auto", color: "var(--pv-text-3)", fontSize: "0.76rem" }}>{new Date(String(j.createdAt)).toLocaleString()}</span>
            </div>
          ))}
          {!(data.jobs as Array<unknown>).length && <Empty title="No provisioning jobs" />}
        </Section>
        <Section title="Audit history">
          {(data.audit as Array<Record<string, unknown>>).map((a) => (
            <div key={String(a.id)} style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "6px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
              <span className="pv-mono">{String(a.event)}</span>
              <span style={{ color: "var(--pv-text-3)", fontSize: "0.76rem", whiteSpace: "nowrap" }}>{String(a.actorUsername ?? "system")} · {new Date(String(a.createdAt)).toLocaleString()}</span>
            </div>
          ))}
          {!(data.audit as Array<unknown>).length && <Empty title="No audit entries" />}
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
    <Section
      title="User access"
      hint="Assigning a user grants them this VM plus all of its Guacamole connections. Removing revokes both."
    >
      {status && (
        <div className={status.ok ? "pv-notice pv-notice-ok" : "pv-error"}>{status.text}</div>
      )}
      <div style={{ marginBottom: 12 }}>
        {assigned.map((a) => (
          <div key={`${a.source}-${a.user.id}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
            <span>
              {a.user.username}
              <span style={{ color: "var(--pv-text-3)", fontSize: "0.76rem", marginLeft: 8 }}>
                {a.source === "group" ? `via group ${a.groupName ?? ""} · ` : ""}
                {a.protocols === null ? "all protocols" : a.protocols.length ? a.protocols.join(", ").toUpperCase() : "no protocols"}
                {a.expiresAt ? ` · expires ${new Date(a.expiresAt).toLocaleString()}` : " · never expires"}
              </span>
            </span>
            {a.source === "direct" ? (
              <Btn size="sm" kind="link" onClick={() => void remove(a.user.id, a.user.username)}>
                Remove
              </Btn>
            ) : (
              <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)" }} title="Group-derived access is managed on the Groups page">managed by group</span>
            )}
          </div>
        ))}
        {!assigned.length && !accessQuery.isLoading && (
          <Empty title={`No users assigned to ${vmName}`} />
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", fontSize: "0.8rem", marginBottom: 12 }}>
        <span className="pv-label" style={{ margin: 0 }}>Protocols</span>
        <label className="pv-checkrow">
          <input
            type="checkbox"
            checked={grantProtocols === null}
            onChange={(e) => setGrantProtocols(e.target.checked ? null : ["ssh", "rdp", "vnc"])}
          />
          All
        </label>
        {["ssh", "rdp", "vnc"].map((p) => (
          <label key={p} className="pv-checkrow" style={{ textTransform: "uppercase" }}>
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
        <span className="pv-label" style={{ margin: 0 }}>Expires</span>
        <select
          className="pv-select pv-input-auto"
          style={{ height: 28, fontSize: "0.78rem" }}
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
            className="pv-input pv-input-auto"
            style={{ height: 28, fontSize: "0.78rem" }}
            value={customExpiry}
            onChange={(e) => setCustomExpiry(e.target.value)}
          />
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {usersQuery.data ? (
          <div style={{ position: "relative" }}>
            <input
              className="pv-input"
              style={{ width: 256 }}
              placeholder="Search users…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {matches.length > 0 && (
              <div style={{ position: "absolute", zIndex: 10, marginTop: 4, width: 256, background: "var(--pv-surface)", border: "1px solid var(--pv-border)", borderRadius: 6, boxShadow: "0 8px 30px rgba(0,0,0,0.45)" }}>
                {matches.map((u) => (
                  <button
                    key={u.id}
                    style={{ width: "100%", textAlign: "left", padding: "7px 12px", fontSize: "0.83rem", background: "none", border: "none", color: "var(--pv-text)", cursor: "pointer", display: "flex", justifyContent: "space-between" }}
                    onClick={() => void assign({ userId: u.id })}
                  >
                    <span>{u.username}</span>
                    <span style={{ color: "var(--pv-text-3)", fontSize: "0.76rem" }}>{u.roles.join(", ")}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <input
            className="pv-input"
            style={{ width: 256 }}
            placeholder="Username to assign…"
            value={usernameInput}
            onChange={(e) => setUsernameInput(e.target.value)}
          />
        )}
        {!usersQuery.data && (
          <Btn size="sm" kind="primary" disabled={!usernameInput.trim()} onClick={() => void assign({ username: usernameInput.trim() })}>
            Assign user
          </Btn>
        )}
      </div>
      {usersQuery.isError && (
        <div className="pv-hint" style={{ marginTop: 8 }}>User directory unavailable — assign by exact username.</div>
      )}
    </Section>
  );
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function MetricChart({ title, current, series, color, series2, color2, label2, format }: {
  title: string;
  current: string;
  series: Array<{ t: number; v: number }>;
  color: string;
  series2?: Array<{ t: number; v: number }>;
  color2?: string;
  label2?: string;
  format: (v: number) => string;
}) {
  const W = 560;
  const H = 150;
  const PAD = 8;
  if (!series.length) {
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.76rem", marginBottom: 4 }}>
          <span style={{ fontWeight: 600 }}>{title}</span>
          <span style={{ color: "var(--pv-text-3)" }}>no data</span>
        </div>
      </div>
    );
  }
  const all = series2 ? [...series.map((s) => s.v), ...series2.map((s) => s.v)] : series.map((s) => s.v);
  const max = Math.max(...all, 1e-9);
  const top = max * 1.1;
  const x = (i: number, n: number): number => (n < 2 ? PAD : PAD + (i / (n - 1)) * (W - PAD * 2));
  const y = (v: number): number => H - PAD - (v / top) * (H - PAD * 2);
  const toLine = (s: Array<{ t: number; v: number }>): string =>
    s.map((p, i) => `${x(i, s.length).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const line = toLine(series);
  const area = `${PAD},${H - PAD} ${line} ${x(series.length - 1, series.length).toFixed(1)},${H - PAD}`;
  const ticks = [0, Math.floor(series.length / 2), series.length - 1]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((i) => ({ x: x(i, series.length), label: fmtTime(series[i]!.t) }));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.76rem", marginBottom: 4 }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span className="pv-mono" style={{ color }}>{current}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 128, background: "var(--pv-inset)", border: "1px solid var(--pv-border-soft)", borderRadius: 6 }}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--pv-border)" strokeWidth="1" />
        ))}
        <polygon points={area} fill={color} opacity="0.18" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" />
        {series2 && color2 && (
          <polyline points={toLine(series2)} fill="none" stroke={color2} strokeWidth="1.5" strokeDasharray="4 2" />
        )}
        {ticks.map((t) => (
          <text key={t.label} x={t.x} y={H - 1} fontSize="9" fill="#64748b" textAnchor="middle">
            {t.label}
          </text>
        ))}
        <text x={W - 3} y={12} fontSize="9" fill="#64748b" textAnchor="end">
          max {format(top)}
        </text>
      </svg>
      {label2 && <div style={{ fontSize: 10, color: "var(--pv-text-3)", marginTop: 4 }}>solid: in/read · dashed {label2}</div>}
    </div>
  );
}

function VmGraphs({ points, timeframe, setTimeframe }: {
  points: Array<Record<string, unknown>>;
  timeframe: string;
  setTimeframe: (t: string) => void;
}) {
  const rows = points
    .map((p) => ({
      t: Number(p.time ?? 0),
      cpu: Number(p.cpu ?? 0),
      maxcpu: Number(p.maxcpu ?? 0),
      mem: Number(p.mem ?? 0),
      maxmem: Number(p.maxmem ?? 0),
      netin: Number(p.netin ?? 0),
      netout: Number(p.netout ?? 0),
      diskread: Number(p.diskread ?? 0),
      diskwrite: Number(p.diskwrite ?? 0),
    }))
    .filter((r) => r.t > 0)
    .sort((a, b) => a.t - b.t);
  const last = rows[rows.length - 1];
  const cpuPct = last && last.maxcpu > 0 ? (last.cpu / last.maxcpu) * 100 : last ? last.cpu * 100 : 0;
  const memPct = last && last.maxmem > 0 ? (last.mem / last.maxmem) * 100 : 0;
  return (
    <Section
      title="Resource graphs"
      actions={
        <select
          className="pv-select pv-input-auto"
          style={{ height: 28, fontSize: "0.78rem" }}
          value={timeframe}
          onChange={(e) => setTimeframe(e.target.value)}
          aria-label="Time range"
        >
          {["hour", "day", "week", "month"].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      }
    >
      {!rows.length ? (
        <Empty title="No data points yet for this range" body="Graphs fill in once the guest reports metrics." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <MetricChart
            title={`CPU${last && last.maxcpu > 0 ? ` (${last.maxcpu} cores)` : ""}`}
            current={`${cpuPct.toFixed(1)}%`}
            color="#60a5fa"
            format={(v) => `${v.toFixed(1)}%`}
            series={rows.map((r) => ({ t: r.t, v: r.maxcpu > 0 ? (r.cpu / r.maxcpu) * 100 : r.cpu * 100 }))}
          />
          <MetricChart
            title={`Memory (${fmtBytes(last?.maxmem ?? 0)} total)`}
            current={`${fmtBytes(last?.mem ?? 0)} · ${memPct.toFixed(0)}%`}
            color="#34d399"
            format={(v) => fmtBytes(v)}
            series={rows.map((r) => ({ t: r.t, v: r.mem }))}
          />
          <MetricChart
            title="Network in / out"
            current={`↓ ${fmtBytes(last?.netin ?? 0)}/s · ↑ ${fmtBytes(last?.netout ?? 0)}/s`}
            color="#22d3ee"
            color2="#a78bfa"
            label2=": out"
            format={(v) => `${fmtBytes(v)}/s`}
            series={rows.map((r) => ({ t: r.t, v: r.netin }))}
            series2={rows.map((r) => ({ t: r.t, v: r.netout }))}
          />
          <MetricChart
            title="Disk read / write"
            current={`R ${fmtBytes(last?.diskread ?? 0)}/s · W ${fmtBytes(last?.diskwrite ?? 0)}/s`}
            color="#fbbf24"
            color2="#f87171"
            label2=": write"
            format={(v) => `${fmtBytes(v)}/s`}
            series={rows.map((r) => ({ t: r.t, v: r.diskread }))}
            series2={rows.map((r) => ({ t: r.t, v: r.diskwrite }))}
          />
        </div>
      )}
    </Section>
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
    <Section
      title="Shareable session links"
      hint="Time-boxed links anyone can open — no account needed. Opening mints a fresh Guacamole session under your identity; revoke anytime."
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <select
          className="pv-select pv-input-auto"
          value={shareProtocol}
          onChange={(e) => setShareProtocol(e.target.value)}
        >
          <option value="">Select protocol…</option>
          {connections.map((p) => (
            <option key={p} value={p}>{p.toUpperCase()}</option>
          ))}
        </select>
        <select
          className="pv-select pv-input-auto"
          value={shareExpiry}
          onChange={(e) => setShareExpiry(e.target.value)}
          title="Link lifetime"
        >
          <option value="60">1 hour</option>
          <option value="1440">1 day</option>
          <option value="10080">7 days</option>
        </select>
        <input
          className="pv-input"
          style={{ width: 112 }}
          placeholder="Max uses (∞)"
          inputMode="numeric"
          value={shareMaxUses}
          onChange={(e) => setShareMaxUses(e.target.value.replace(/[^0-9]/g, ""))}
        />
        <Btn size="sm" kind="primary" onClick={() => shareProtocol && onShare(shareProtocol)} disabled={!shareProtocol}>
          Create link
        </Btn>
      </div>
      {shareUrl && (
        <div className="pv-notice pv-notice-ok" style={{ fontSize: "0.8rem" }}>
          Share this URL (shown once — copy it now):{" "}
          <code className="pv-mono" style={{ wordBreak: "break-all", userSelect: "all" }}>{shareUrl}</code>
        </div>
      )}
      {active.length > 0 ? (
        active.map((l) => (
          <div key={l.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: "0.8rem", padding: "6px 0", borderBottom: "1px solid var(--pv-border-soft)" }}>
            <span className="pv-mono" style={{ textTransform: "uppercase" }}>{l.protocol}</span>
            <span style={{ color: "var(--pv-text-2)" }}>expires {new Date(l.expiresAt).toLocaleString()}</span>
            <span style={{ color: "var(--pv-text-2)" }}>used {l.useCount}{l.maxUses === null ? "" : `/${l.maxUses}`}</span>
            <Btn size="sm" kind="link" onClick={() => onRevoke(l.id)}>Revoke</Btn>
          </div>
        ))
      ) : (
        <Empty title="No active share links for this VM" />
      )}
    </Section>
  );
}
