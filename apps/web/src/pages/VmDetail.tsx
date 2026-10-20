import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  MoreHorizontal,
  Play,
  Square,
  RotateCw,
  RefreshCw,
  Trash2,
  Copy,
  Eye,
  Network,
  Users as UsersIcon,
  CloudUpload,
  Layers,
  MapPin,
} from "lucide-react";
import { api, explainDenial, jobEventSource } from "../api.js";
import { usePref } from "../prefs.js";
import { makeCan, useEffectivePermissions } from "../iam.js";
import { hasPermission, type Me } from "../lib/permissions.js";
import { fmtBytes, fmtUptime, fmtDateTime, copyToClipboard } from "../lib/format.js";
import {
  PageHeader, Section, KeyValue, Tabs, Btn, StatusBadge, Badge, EmptyState,
  Alert, Menu, Dialog, Field, Input, Select, Checkbox, useConfirm, useToast, errText,
  TableSkeleton, CopyButton, CopyableCode, Tooltip,
} from "../ui/index.js";
import VmFirewallSection from "./VmFirewallSection.js";

export default function VmDetail({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const can = makeCan(useEffectivePermissions(), (perm) => hasPermission(me, perm));

  const { data, error, isLoading } = useQuery({
    queryKey: ["vm", id],
    queryFn: () => api<Record<string, unknown>>(`/vms/${id}`),
    refetchInterval: 10000,
  });

  const [revealed, setRevealed] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [cloneTarget, setCloneTarget] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [timeframe, setTimeframe] = usePref("vmdetail-stats-range", "day");
  const [migrating, setMigrating] = useState<{
    target: string;
    upid: string;
    online: boolean;
    detachedIso: string[];
    startedAt: number;
  } | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const canManage = can("vm.manage");
  const canReadNodes = can("proxmox.read");
  const canEdit = can("vm.edit");
  const canDelete = can("vm.delete");
  const canReveal = can("cred.reveal");
  const canRotate = can("cred.rotate");
  const canLaunch = can("guac.launch");
  const canClone = can("vm.create");
  const canTemplate = can("templates.manage");

  const { data: nodesData } = useQuery({
    queryKey: ["proxmox-nodes"],
    queryFn: () => api<{ nodes: Array<{ node: string; status: string }> }>("/proxmox/nodes"),
    enabled: canManage && canReadNodes,
    staleTime: 60000,
  });
  const { data: statsData } = useQuery({
    queryKey: ["vm-stats", id, timeframe],
    queryFn: () => api<{ points: Array<Record<string, unknown>> }>(`/vms/${id}/stats?timeframe=${timeframe}`),
    staleTime: 60000,
  });
  const { data: sharesData } = useQuery({
    queryKey: ["vm-shares", id],
    queryFn: () =>
      api<{ links: Array<{ id: string; vmId: string; protocol: string; expiresAt: string; maxUses: number | null; useCount: number; revokedAt: string | null; createdAt: string }> }>(
        "/share",
      ),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["vm", id] });
    void qc.invalidateQueries({ queryKey: ["vms"] });
  };

  // Async migration: POST returns 202 (long migrations exceed proxy
  // timeouts), then we poll until Proxmox reports the task stopped.
  // Polling stops on unmount; the migration continues server-side.
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
          toast.ok(`Migration to ${migrating.target} complete`);
          refresh();
          return;
        }
        if (st.state === "error") {
          setMigrating(null);
          toast.err(
            `Migration to ${migrating.target} failed`,
            `${st.exitStatus ?? "unknown error"} — the VM is still on its source node.`,
          );
          refresh();
          return;
        }
        failures = 0;
        if (Date.now() > deadline) {
          setMigrating(null);
          toast.warn("Migration still running", "Status polling timed out; it continues server-side. Reload to check.");
          return;
        }
        timer = setTimeout(() => void tick(), 5000);
      } catch {
        // Transient blips shouldn't kill the poll; give up after repeated failures.
        failures += 1;
        if (failures >= 5) {
          if (!cancelled) {
            setMigrating(null);
            toast.warn("Lost contact with migration status", "The migration may still be running server-side; reload to check.");
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
  }, [migrating, id, qc]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------ actions ----------------------------- */

  const doAction = async (action: "start" | "stop" | "restart") => {
    if (action !== "start") {
      const ok = await confirm({
        title: `${action === "stop" ? "Stop" : "Restart"} this VM?`,
        danger: action === "stop",
        confirmLabel: action === "stop" ? "Stop VM" : "Restart VM",
        body: "The guest receives the ACPI signal — unsaved work inside it may be lost. Use a forced stop from the API if the guest does not respond.",
      });
      if (!ok) return;
    }
    setActionBusy(action);
    try {
      await api(`/vms/${id}/${action}`, { method: "POST", body: {} });
      toast.info(`${action[0]!.toUpperCase()}${action.slice(1)} requested`, "Waiting for Proxmox to apply the change.");
      refresh();
    } catch (err) {
      toast.err(`${action[0]!.toUpperCase()}${action.slice(1)} failed`, explainDenial(err) ?? errText(err));
    } finally {
      setActionBusy(null);
    }
  };

  const rotate = async () => {
    setActionBusy("rotate");
    try {
      const res = await api<{ success: boolean; mechanism: string; verified: boolean; details: string }>(
        `/vms/${id}/credentials/rotate`,
        { method: "POST", body: {} },
      );
      if (res.success) toast.ok("Password rotated", `Mechanism: ${res.mechanism}, verified: ${res.verified}. ${res.details}`);
      else toast.warn("Rotation completed with issues", res.details);
      refresh();
    } catch (err) {
      toast.err("Rotation failed", errText(err));
    } finally {
      setActionBusy(null);
    }
  };

  const reveal = async () => {
    setActionBusy("reveal");
    try {
      const res = await api<{ password: string; autoHideSeconds?: number }>(`/vms/${id}/credentials/reveal`, { method: "POST" });
      setRevealed(res.password);
      setTimeout(() => setRevealed(null), (res.autoHideSeconds ?? 30) * 1000);
    } catch (err) {
      toast.err("Reveal failed", errText(err));
    } finally {
      setActionBusy(null);
    }
  };

  const copyCredential = async () => {
    setActionBusy("copy");
    try {
      const res = await api<{ password: string }>(`/vms/${id}/credentials/copy`, { method: "POST" });
      const ok = await copyToClipboard(res.password);
      setRevealed(res.password);
      setTimeout(() => setRevealed(null), 30000);
      if (ok) toast.ok("Copied to clipboard", "The password also shows below for 30 seconds.");
      else toast.warn("Clipboard unavailable", "The password is shown below — copy it manually.");
    } catch (err) {
      toast.err("Copy failed", errText(err));
    } finally {
      setActionBusy(null);
    }
  };

  const launch = async (protocol?: string) => {
    setActionBusy("launch");
    try {
      const res = await api<{ url: string; mode?: string; detail?: string }>(`/vms/${id}/guacamole/launch`, {
        method: "POST",
        body: protocol ? { protocol } : {},
      });
      if (res.mode === "login") {
        toast.warn("Direct session unavailable", res.detail ?? "Opening the Guacamole login page instead.");
      }
      window.open(res.url, "_blank", "noopener");
    } catch (err) {
      toast.err("Could not open console", explainDenial(err) ?? errText(err));
    } finally {
      setActionBusy(null);
    }
  };

  const del = async (vmName: string) => {
    const ok = await confirm({
      title: `Delete ${vmName}?`,
      danger: true,
      requireText: `DELETE ${vmName}`,
      confirmLabel: "Delete VM",
      body: "Deletes the VM from Proxmox, its Guacamole connection, and its stored credential. This cannot be undone.",
    });
    if (!ok) return;
    try {
      await api(`/vms/${id}`, { method: "DELETE", body: { confirmText: `DELETE ${vmName}` } });
      toast.ok("VM deleted", `${vmName} removed.`);
      navigate("/vms");
    } catch (err) {
      toast.err("Delete failed", errText(err));
    }
  };

  /* ------------------------------- render ----------------------------- */

  if (isLoading && !data) {
    return (
      <div className="pv-page">
        <div style={{ paddingTop: 20 }}><TableSkeleton rows={5} cols={3} /></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="pv-page">
        <Alert kind="err" title="Failed to load this VM">
          {explainDenial(error) ?? errText(error)}
          <div style={{ marginTop: 8 }}>
            <Link to="/vms">← Back to virtual machines</Link>
          </div>
        </Alert>
      </div>
    );
  }

  const vm = data.vm as {
    name: string; vmid: number; node: string; status: string; ip: string | null;
    osType: string | null; osName?: string | null; private?: boolean; viewerAccess?: boolean;
    vmClass?: string; startOnBoot?: boolean; createdAt?: string;
  };
  const proxmox = data.proxmox as Record<string, unknown> | null;
  const cred = data.credential as { username?: string; status?: string } | null;
  const guac = data.guacamole as {
    connections?: Array<{ protocol: string; status: string; port: number; hostname: string; username: string; connectionName: string }>;
    active?: { protocol: string; status: string; port: number; hostname: string } | null;
  } | null;
  const jobs = (data.jobs ?? []) as Array<Record<string, unknown>>;
  const audit = (data.audit ?? []) as Array<Record<string, unknown>>;
  const connections = guac?.connections ?? [];
  const status = String(proxmox?.status ?? vm.status);

  const tab = params.get("tab") ?? "overview";
  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    if (t === "overview") next.delete("tab");
    else next.set("tab", t);
    setParams(next, { replace: true });
  };

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      panel: (
        <>
          <KeyValue
            columns={3}
            items={[
              { key: "status", label: "Status", value: <StatusBadge status={status} /> },
              { key: "ip", label: "IP", value: vm.ip ? <CopyableCode value={vm.ip} /> : <span className="pv-faint">—</span> },
              { key: "os", label: "OS", value: vm.osName ?? vm.osType ?? "Unknown" },
              { key: "cpu", label: "CPUs", value: String(proxmox?.cores ?? "—") },
              { key: "mem", label: "Memory", value: proxmox?.memory ? `${proxmox.memory} MB` : "—" },
              { key: "disk", label: "Disk", value: proxmox?.disk ? `${proxmox.disk}` : "—" },
              { key: "uptime", label: "Uptime", value: fmtUptime(proxmox?.uptime) },
              { key: "agent", label: "Guest agent", value: String(proxmox?.agent ?? "—") },
              { key: "created", label: "Created", value: fmtDateTime(vm.createdAt) },
              { key: "guac", label: "Console", value: guac?.active ? <StatusBadge status={String(guac.active.status)} /> : "not created" },
              {
                key: "cred",
                label: "Credential",
                value: cred ? <span><StatusBadge status={String(cred.status)} /> {cred.username ? <span className="pv-faint">· {cred.username}</span> : null}</span> : "none",
              },
              {
                key: "boot",
                label: "Start on boot",
                value: vm.startOnBoot ? <Badge tone="info">on</Badge> : <Badge>off</Badge>,
              },
            ]}
          />
          {connections.length > 0 && (
            <Section title="Remote connections" hint="Protocols exposed through Guacamole">
              <ConnectionTable connections={connections} canLaunch={canLaunch} vmId={id} busy={actionBusy} onLaunch={launch} />
            </Section>
          )}
          <VmGraphs points={statsData?.points ?? []} timeframe={timeframe} setTimeframe={setTimeframe} />
        </>
      ),
    },
    {
      id: "access",
      label: "Access",
      panel: (
        <>
          {canEdit ? (
            <UserAccessSection vmId={id} vmName={vm.name} refresh={refresh} />
          ) : (
            <Section title="User access" hint="Granting and revoking requires the VM edit permission.">
              <AccessReadonly vmId={id} />
            </Section>
          )}
          {canEdit && (
            <VmShareSection
              vmId={id}
              connections={connections.map((c) => c.protocol)}
              links={(sharesData?.links ?? []).filter((l) => l.vmId === id)}
              refreshShare={() => void qc.invalidateQueries({ queryKey: ["vm-shares", id] })}
            />
          )}
          {vm.viewerAccess && <InviteSection vmId={id} refresh={refresh} />}
          <Section
            title="Credentials"
            hint="Server-mediated reveal and rotation — audited events, 30-second auto-hide."
          >
            <div className="pv-inline">
              {canReveal && (
                <Btn onClick={() => void reveal()} loading={actionBusy === "reveal"}>
                  <Eye size={13} aria-hidden="true" /> Reveal password
                </Btn>
              )}
              {canReveal && (
                <Btn onClick={() => void copyCredential()} loading={actionBusy === "copy"}>
                  <Copy size={13} aria-hidden="true" /> Copy password
                </Btn>
              )}
              {canRotate && (
                <Btn kind="danger-ghost" onClick={() => void rotate()} loading={actionBusy === "rotate"}>
                  <RefreshCw size={13} aria-hidden="true" /> Rotate password
                </Btn>
              )}
            </div>
            {revealed && (
              <Alert kind="ok" title="Password revealed (auto-hides in 30s)">
                <code className="pv-mono" style={{ userSelect: "all", wordBreak: "break-all" }}>{revealed}</code>
              </Alert>
            )}
          </Section>
        </>
      ),
    },
    {
      id: "firewall",
      label: "Network & isolation",
      panel: canEdit ? (
        <VmFirewallSection vmId={id} />
      ) : (
        <EmptyState title="Firewall management unavailable" body="Editing the isolation firewall requires the VM edit permission." />
      ),
    },
    {
      id: "tasks",
      label: "Tasks",
      panel: (
        <Section title="Provisioning jobs" hint="Background operations run by the worker; watch live progress.">
          {!jobs.length ? (
            <EmptyState title="No provisioning jobs" body="Jobs for this VM appear here after provisioning, cloning, or templating." />
          ) : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead>
                  <tr><th>Job</th><th>Status</th><th>Created</th><th></th></tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={String(j.id)}>
                      <td className="pv-mono">{String(j.id).slice(0, 8)}</td>
                      <td><StatusBadge status={String(j.status)} /></td>
                      <td className="pv-faint">{fmtDateTime(String(j.createdAt))}</td>
                      <td style={{ textAlign: "right" }}>
                        <WatchJobButton jobId={String(j.id)} onProgress={setProgress} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {progress && (
            <div className="pv-mono" style={{ marginTop: 10, fontSize: "0.78rem", color: "var(--pv-text-2)" }} role="status">
              {progress}
            </div>
          )}
        </Section>
      ),
    },
    {
      id: "audit",
      label: "Audit",
      panel: (
        <Section title="Audit history" hint="Recorded actions on this VM (actor, time, event).">
          {!audit.length ? (
            <EmptyState title="No audit entries" />
          ) : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead>
                  <tr><th>Event</th><th>Actor</th><th>Time</th></tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={String(a.id)}>
                      <td className="pv-mono">{String(a.event)}</td>
                      <td>{String(a.actorUsername ?? "system")}</td>
                      <td className="pv-faint">{fmtDateTime(String(a.createdAt))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      ),
    },
  ];

  return (
    <div className="pv-page">
      <div style={{ marginBottom: 10 }}>
        <Link to="/vms" style={{ fontSize: "0.8rem", display: "inline-flex", alignItems: "center", gap: 5, minHeight: 24 }}>
          <ArrowLeft size={12} aria-hidden="true" /> Virtual machines
        </Link>
      </div>
      <PageHeader
        title={vm.name}
        meta={
          <>
            <StatusBadge status={status} />
            <span className="pv-mono pv-faint" style={{ fontWeight: 400, fontSize: "0.8rem" }}>
              {vm.vmid} @ {vm.node}
            </span>
            {vm.private && <Badge tone="plain" icon={<Eye size={10} aria-hidden="true" />}>private</Badge>}
            {vm.vmClass === "user" ? <Badge tone="plain" icon={<UsersIcon size={10} aria-hidden="true" />}>user class</Badge> : null}
          </>
        }
        actions={
          <>
            {canLaunch && connections.length > 0 && (
              connections.length === 1 ? (
                <Btn kind="primary" onClick={() => void launch(connections[0]!.protocol)} loading={actionBusy === "launch"}>
                  <Network size={13} aria-hidden="true" /> Open {connections[0]!.protocol.toUpperCase()}
                </Btn>
              ) : (
                <Menu
                  label="Open console"
                  trigger={({ open, toggle, ref }) => (
                    <button ref={ref} className="pv-btn pv-btn-primary" aria-expanded={open} onClick={toggle}>
                      <Network size={13} aria-hidden="true" /> Open console
                    </button>
                  )}
                  items={connections.map((c) => ({
                    label: `${c.protocol.toUpperCase()} — ${c.hostname}:${c.port}`,
                    onSelect: () => void launch(c.protocol),
                  }))}
                />
              )
            )}
            {canManage && (
              <>
                <Btn onClick={() => void doAction("start")} disabled={status === "running" || actionBusy !== null}>
                  <Play size={13} aria-hidden="true" /> Start
                </Btn>
                <Btn onClick={() => void doAction("stop")} disabled={status === "stopped" || actionBusy !== null}>
                  <Square size={13} aria-hidden="true" /> Stop
                </Btn>
                <Btn onClick={() => void doAction("restart")} disabled={status !== "running" || actionBusy !== null}>
                  <RotateCw size={13} aria-hidden="true" /> Restart
                </Btn>
              </>
            )}
            {(canClone || canTemplate || canManage || canEdit || canDelete) && (
              <Menu
                label="More actions"
                trigger={({ open, toggle, ref }) => (
                  <button ref={ref} className="pv-btn pv-btn-icon" aria-expanded={open} aria-label="More actions" onClick={toggle}>
                    <MoreHorizontal size={15} aria-hidden="true" />
                  </button>
                )}
                items={[
                  ...(canClone
                    ? [{
                        label: "Clone…",
                        icon: <Layers size={13} aria-hidden="true" />,
                        onSelect: () => { setCloneOpen(true); setCloneName(`${vm.name}-copy`); },
                      }]
                    : []),
                  ...(canManage
                    ? [{
                        label: "Migrate…",
                        icon: <MapPin size={13} aria-hidden="true" />,
                        disabled: migrating !== null,
                        onSelect: () => document.getElementById("pv-migrate-anchor")?.scrollIntoView({ behavior: "smooth", block: "center" }),
                      }]
                    : []),
                  ...(canTemplate
                    ? [{
                        label: "Save as template…",
                        icon: <CloudUpload size={13} aria-hidden="true" />,
                        onSelect: () => { setTemplateOpen(true); setTemplateName(`${vm.name}-template`); },
                      }]
                    : []),
                  ...(canDelete
                    ? [{
                        label: "Delete…",
                        icon: <Trash2 size={13} aria-hidden="true" />,
                        danger: true,
                        onSelect: () => void del(vm.name),
                      }]
                    : []),
                ]}
              />
            )}
          </>
        }
      />

      {migrating && (
        <Alert kind="info" title={`Migrating to ${migrating.target}…`}>
          {migrating.online ? "Live migration" : "Offline migration"} in progress — checking status
          every few seconds. It is safe to leave this page; the migration continues server-side.
        </Alert>
      )}

      <div id="pv-migrate-anchor" />

      <Tabs tabs={tabs} active={tab} onChange={setTab} label="VM detail sections" />

      {(canManage || canEdit) && (
        <ManageSection
          vm={vm}
          nodes={nodesData?.nodes ?? []}
          canManage={canManage}
          canEdit={canEdit}
          canClone={canClone}
          cloneOpen={cloneOpen}
          setCloneOpen={setCloneOpen}
          cloneName={cloneName}
          setCloneName={setCloneName}
          cloneTarget={cloneTarget}
          setCloneTarget={setCloneTarget}
          templateOpen={templateOpen}
          setTemplateOpen={setTemplateOpen}
          templateName={templateName}
          setTemplateName={setTemplateName}
          migrating={migrating}
          setMigrating={setMigrating}
          refresh={refresh}
          vmId={id}
        />
      )}
    </div>
  );
}

/* =========================== connection table ========================= */

function ConnectionTable({
  connections,
  canLaunch,
  vmId,
  busy,
  onLaunch,
}: {
  connections: Array<{ protocol: string; status: string; port: number; hostname: string; username: string; connectionName: string }>;
  canLaunch: boolean;
  vmId: string;
  busy: string | null;
  onLaunch: (protocol?: string) => void;
}) {
  const [tests, setTests] = useState<Record<string, { testing: boolean; text?: string; ok?: boolean }>>({});

  const testConnection = async (protocol: string) => {
    setTests((t) => ({ ...t, [protocol]: { testing: true } }));
    try {
      const res = await api<{ reachable: boolean; authenticated: boolean | null; detail: string }>(
        `/vms/${vmId}/guacamole/test`,
        { method: "POST", body: { protocol } },
      );
      const ok = res.reachable && res.authenticated !== false;
      setTests((t) => ({
        ...t,
        [protocol]: {
          testing: false,
          ok,
          text: `${res.reachable ? "Reachable" : "Unreachable"}${res.authenticated === null ? "" : res.authenticated ? ", authenticated" : ", NOT authenticated"} — ${res.detail}`,
        },
      }));
    } catch (err) {
      setTests((t) => ({ ...t, [protocol]: { testing: false, ok: false, text: errText(err) } }));
    }
  };

  return (
    <div className="pv-table-wrap">
      <table className="pv-table">
        <thead>
          <tr>
            <th>Protocol</th>
            <th>Status</th>
            <th>Target</th>
            <th>User</th>
            <th style={{ width: 150 }}>Diagnostics</th>
          </tr>
        </thead>
        <tbody>
          {connections.map((c) => (
            <tr key={c.protocol}>
              <td className="pv-mono" style={{ textTransform: "uppercase" }}>{c.protocol}</td>
              <td><StatusBadge status={c.status} /></td>
              <td className="pv-mono">{c.hostname}:{c.port}</td>
              <td>{c.username}</td>
              <td>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {canLaunch && (
                    <button className="pv-btn pv-btn-sm" onClick={() => void onLaunch(c.protocol)} disabled={busy !== null}>
                      Open
                    </button>
                  )}
                  <button
                    className="pv-btn pv-btn-sm"
                    disabled={tests[c.protocol]?.testing}
                    onClick={() => void testConnection(c.protocol)}
                  >
                    {tests[c.protocol]?.testing ? "Testing…" : "Test"}
                  </button>
                </div>
                {tests[c.protocol]?.text && (
                  <div style={{ fontSize: "0.74rem", marginTop: 3, color: tests[c.protocol]?.ok ? "var(--pv-ok)" : "var(--pv-err)" }}>
                    {tests[c.protocol]!.text}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ============================ manage section ========================== */

function ManageSection({
  vm, nodes, canManage, canEdit, canClone,
  cloneOpen, setCloneOpen, cloneName, setCloneName, cloneTarget, setCloneTarget,
  templateOpen, setTemplateOpen, templateName, setTemplateName,
  migrating, setMigrating, refresh, vmId,
}: {
  vm: { name: string; node: string; private?: boolean; vmClass?: string; startOnBoot?: boolean; viewerAccess?: boolean };
  nodes: Array<{ node: string; status: string }>;
  canManage: boolean; canEdit: boolean; canClone: boolean;
  cloneOpen: boolean; setCloneOpen: (v: boolean) => void;
  cloneName: string; setCloneName: (v: string) => void;
  cloneTarget: string; setCloneTarget: (v: string) => void;
  templateOpen: boolean; setTemplateOpen: (v: boolean) => void;
  templateName: string; setTemplateName: (v: string) => void;
  migrating: { target: string } | null;
  setMigrating: (m: { target: string; upid: string; online: boolean; detachedIso: string[]; startedAt: number } | null) => void;
  refresh: () => void;
  vmId: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [migrateTarget, setMigrateTarget] = useState("");
  const [migrateOnline, setMigrateOnline] = useState(true);

  const doClone = async () => {
    try {
      const res = await api<{ vm: { id: string; name: string } }>(`/vms/${vmId}/clone`, {
        method: "POST",
        body: { name: cloneName, target: cloneTarget || undefined },
      });
      toast.ok("Clone started", `${res.vm.name} is being created.`);
      setCloneOpen(false);
      setCloneName("");
      refresh();
    } catch (err) {
      toast.err("Clone failed", errText(err));
    }
  };

  const doMigrate = async () => {
    try {
      const res = await api<{ accepted: boolean; upid: string; detachedIso: string[] }>(`/vms/${vmId}/migrate`, {
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
      toast.info("Migration accepted", `Moving to ${migrateTarget} — progress is tracked on this page.`);
    } catch (err) {
      toast.err("Migration failed to start", errText(err));
    }
  };

  const doMakeTemplate = async () => {
    try {
      const res = await api<{ template: { name: string } }>(`/vms/${vmId}/make-template`, {
        method: "POST",
        body: { name: templateName },
      });
      toast.ok("Template registered", `${res.template.name} is available for provisioning.`);
      setTemplateOpen(false);
      setTemplateName("");
      void qc.invalidateQueries({ queryKey: ["templates"] });
      refresh();
    } catch (err) {
      toast.err("Template conversion failed", errText(err));
    }
  };

  const togglePrivacy = async () => {
    try {
      const res = await api<{ private: boolean }>(`/vms/${vmId}/privacy`, {
        method: "PATCH",
        body: { enabled: !vm.private },
      });
      if (res.private) {
        toast.ok("Privacy flag on", "Only users with a direct grant — including admins — can see this VM now.");
      } else {
        toast.info("Privacy flag off", "Administrators can see and manage this VM without a grant.");
      }
      refresh();
    } catch (err) {
      toast.err("Privacy change failed", errText(err));
    }
  };

  const setStartOnBoot = async (enabled: boolean) => {
    try {
      await api(`/vms/${vmId}/start-on-boot`, { method: "PATCH", body: { enabled } });
      toast.ok(
        enabled ? "Start on host boot enabled" : "Start on host boot disabled",
        enabled ? "Proxmox will power this VM on when its node boots." : "This VM stays stopped across node reboots.",
      );
      refresh();
    } catch (err) {
      toast.err("Change failed", errText(err));
    }
  };

  const setClass = async (vmClass: "server" | "user") => {
    try {
      await api(`/vms/${vmId}/class`, { method: "PATCH", body: { vmClass } });
      toast.ok(
        vmClass === "user" ? "Marked as user VM" : "Marked as server VM",
        vmClass === "user" ? "Eligible for idle auto-shutdown when the global switch is on." : "Never auto-shut down.",
      );
      refresh();
    } catch (err) {
      toast.err("Change failed", errText(err));
    }
  };

  const otherNodes = nodes.filter((n) => n.node !== vm.node);

  return (
    <Section title="Manage" hint="Clone, migrate, template, policy flags">
      <div className="pv-grid-3">
        {canClone && (
          <div>
            <div className="pv-label">Clone this VM</div>
            {!cloneOpen ? (
              <Btn size="sm" onClick={() => { setCloneOpen(true); setCloneName(`${vm.name}-copy`); }}>
                <Layers size={12} aria-hidden="true" /> Clone…
              </Btn>
            ) : (
              <div>
                <Input style={{ marginBottom: 8 }} placeholder="Clone name" value={cloneName} onChange={(e) => setCloneName(e.target.value)} />
                {otherNodes.length > 0 && (
                  <Select style={{ marginBottom: 8 }} value={cloneTarget} onChange={(e) => setCloneTarget(e.target.value)} aria-label="Clone target node">
                    <option value="">Same node ({vm.node})</option>
                    {otherNodes.map((n) => (
                      <option key={n.node} value={n.node}>{n.node} ({n.status})</option>
                    ))}
                  </Select>
                )}
                <div className="pv-inline">
                  <Btn size="sm" kind="primary" onClick={() => void doClone()} disabled={!cloneName.trim()}>Clone</Btn>
                  <Btn size="sm" onClick={() => setCloneOpen(false)}>Cancel</Btn>
                </div>
              </div>
            )}
          </div>
        )}
        {canManage && (
          <div>
            <div className="pv-label">Migrate to another node</div>
            {otherNodes.length > 0 ? (
              <div>
                <Select style={{ marginBottom: 8 }} value={migrateTarget} onChange={(e) => setMigrateTarget(e.target.value)} aria-label="Migration target node">
                  <option value="">Select target…</option>
                  {otherNodes.map((n) => (
                    <option key={n.node} value={n.node}>{n.node} ({n.status})</option>
                  ))}
                </Select>
                <Checkbox
                  label="Online migration (keeps the VM running)"
                  checked={migrateOnline}
                  onChange={(e) => setMigrateOnline(e.target.checked)}
                  style={{ marginBottom: 8 }}
                />
                <Btn size="sm" onClick={() => void doMigrate()} disabled={!migrateTarget || migrating !== null}>
                  {migrating ? `Migrating to ${migrating.target}…` : "Migrate"}
                </Btn>
              </div>
            ) : (
              <div className="pv-hint">Single-node cluster or node list unavailable.</div>
            )}
          </div>
        )}
        <div>
          <div className="pv-label">Classification & boot policy</div>
          <div className="pv-hint" style={{ marginBottom: 6 }}>
            {(vm.vmClass ?? "server") === "user"
              ? "User VM — eligible for idle auto-shutdown."
              : "Server VM — never auto-shut down."}
          </div>
          {canEdit && (
            <div className="pv-seg" role="group" aria-label="VM class" style={{ marginBottom: 12 }}>
              <button className={`pv-seg-btn${(vm.vmClass ?? "server") === "server" ? " pv-seg-btn-active" : ""}`} onClick={() => void setClass("server")}>Server</button>
              <button className={`pv-seg-btn${vm.vmClass === "user" ? " pv-seg-btn-active" : ""}`} onClick={() => void setClass("user")}>User</button>
            </div>
          )}
          {canEdit && (
            <>
              <div className="pv-hint" style={{ marginBottom: 6 }}>
                {vm.startOnBoot ? "Powers on automatically when the node boots." : "Stays stopped across node reboots."}
              </div>
              <div className="pv-seg" role="group" aria-label="Start on boot">
                <button className={`pv-seg-btn${vm.startOnBoot ? " pv-seg-btn-active" : ""}`} onClick={() => void setStartOnBoot(true)}>Start on boot</button>
                <button className={`pv-seg-btn${!vm.startOnBoot ? " pv-seg-btn-active" : ""}`} onClick={() => void setStartOnBoot(false)}>Manual</button>
              </div>
            </>
          )}
          {(vm.viewerAccess || !vm.private) && (
            <div style={{ marginTop: 14 }}>
              <div className="pv-hint" style={{ marginBottom: 6 }}>
                {vm.private
                  ? "Private — invisible without a direct grant."
                  : "Visible to administrators without a grant."}
              </div>
              <Btn size="sm" onClick={() => void togglePrivacy()}>
                Turn {vm.private ? "off" : "on"} privacy
              </Btn>
            </div>
          )}
        </div>
      </div>

      {cloneOpen && (
        <div aria-hidden="true" />
      )}

      <Dialog
        title={`Clone ${vm.name}`}
        onClose={() => setCloneOpen(false)}
        footer={
          <>
            <Btn onClick={() => setCloneOpen(false)}>Cancel</Btn>
            <Btn kind="primary" onClick={() => void doClone()} disabled={!cloneName.trim()}>Clone</Btn>
          </>
        }
      >
        <Field label="Clone name" required>
          {({ id }) => <Input id={id} value={cloneName} onChange={(e) => setCloneName(e.target.value)} />}
        </Field>
        {otherNodes.length > 0 && (
          <Field label="Target node" hint="Leave on same node for the fastest clone.">
            {({ id }) => (
              <Select id={id} value={cloneTarget} onChange={(e) => setCloneTarget(e.target.value)}>
                <option value="">Same node ({vm.node})</option>
                {otherNodes.map((n) => (
                  <option key={n.node} value={n.node}>{n.node} ({n.status})</option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </Dialog>

      <Dialog
        title={`Convert ${vm.name} to template`}
        onClose={() => setTemplateOpen(false)}
        footer={
          <>
            <Btn onClick={() => setTemplateOpen(false)}>Cancel</Btn>
            <Btn kind="primary" onClick={() => void doMakeTemplate()} disabled={!templateName.trim()}>Convert</Btn>
          </>
        }
      >
        <Field label="Template name" required>
          {({ id }) => <Input id={id} value={templateName} onChange={(e) => setTemplateName(e.target.value)} />}
        </Field>
        <div className="pv-hint">The VM must be stopped; Proxmox converts it in place.</div>
      </Dialog>
    </Section>
  );
}

/* ============================ access section ========================== */

interface AccessUser {
  id: string;
  username: string;
  roles: string[];
  active: boolean;
}

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

function AccessReadonly({ vmId }: { vmId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["vm-access", vmId],
    queryFn: () => api<{ access: AccessEntry[] }>(`/vms/${vmId}/access`),
  });
  const access = data?.access ?? [];
  if (isLoading) return <TableSkeleton rows={2} cols={3} />;
  if (!access.length) return <EmptyState title="No users assigned" />;
  return (
    <div>
      {access.map((a) => (
        <div key={`${a.source}-${a.user.id}`} className="pv-list-row">
          <span>{a.user.username}</span>
          <span className="pv-faint" style={{ fontSize: "0.76rem" }}>
            {a.source === "group" ? `via group ${a.groupName ?? ""}` : "direct"}
          </span>
        </div>
      ))}
    </div>
  );
}

function UserAccessSection({ vmId, vmName, refresh }: { vmId: string; vmName: string; refresh: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [grantProtocols, setGrantProtocols] = useState<string[] | null>(null);
  const [grantExpiry, setGrantExpiry] = useState("");
  const [customExpiry, setCustomExpiry] = useState("");
  const [busy, setBusy] = useState(false);

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
    if (grantExpiry === "custom" && !expiryIso()) {
      toast.warn("Invalid expiration", "Pick a valid custom expiration date/time.");
      return;
    }
    setBusy(true);
    const body: Record<string, unknown> = { ...who };
    if (grantProtocols !== null) body.protocols = grantProtocols;
    const expiresAt = expiryIso();
    if (expiresAt) body.expiresAt = expiresAt;
    try {
      const res = await api<{ changed: boolean; guacSynced: boolean; protocols: string[] | null; expiresAt: string | null; user: AccessUser }>(
        `/vms/${vmId}/access`,
        { method: "POST", body },
      );
      const protoText = !res.protocols
        ? "all protocols"
        : res.protocols.length
          ? res.protocols.join(", ").toUpperCase()
          : "no protocols";
      const expText = res.expiresAt ? `, expires ${fmtDateTime(res.expiresAt)}` : "";
      toast.ok(
        res.changed ? `Granted ${res.user.username} access` : `${res.user.username} re-synced`,
        `${protoText}${expText}.`,
      );
      setSearch("");
      reload();
    } catch (err) {
      toast.err("Grant failed", errText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (targetUserId: string, targetUsername: string) => {
    try {
      await api(`/vms/${vmId}/access/${targetUserId}`, { method: "DELETE" });
      toast.ok(`Removed ${targetUsername}`, "ProxVM and Guacamole access revoked.");
      reload();
    } catch (err) {
      toast.err("Removal failed", errText(err));
    }
  };

  return (
    <Section
      title="User access"
      hint="Assigning a user grants them this VM plus all of its Guacamole connections. Removing revokes both."
    >
      <div style={{ marginBottom: 14 }}>
        {assigned.map((a) => (
          <div key={`${a.source}-${a.user.id}`} className="pv-list-row">
            <span style={{ flex: 1, minWidth: 0 }}>
              {a.user.username}
              <span className="pv-faint" style={{ fontSize: "0.76rem", marginLeft: 8 }}>
                {a.source === "group" ? `via group ${a.groupName ?? ""} · ` : ""}
                {a.protocols === null ? "all protocols" : a.protocols.length ? a.protocols.join(", ").toUpperCase() : "no protocols"}
                {a.expiresAt ? ` · expires ${fmtDateTime(a.expiresAt)}` : " · never expires"}
              </span>
            </span>
            {a.source === "direct" ? (
              <button className="pv-btn pv-btn-link" style={{ fontSize: "0.78rem" }} onClick={() => void remove(a.user.id, a.user.username)}>
                Remove
              </button>
            ) : (
              <Tooltip content="Group-derived access is managed on the Groups page">
                <span className="pv-faint" style={{ fontSize: "0.76rem" }}>managed by group</span>
              </Tooltip>
            )}
          </div>
        ))}
        {!assigned.length && !accessQuery.isLoading && <EmptyState title={`No users assigned to ${vmName}`} />}
      </div>

      <div className="pv-inline" style={{ marginBottom: 12, gap: 14, fontSize: "0.8rem" }}>
        <span className="pv-label" style={{ margin: 0 }}>Protocols</span>
        <Checkbox
          label="All"
          checked={grantProtocols === null}
          onChange={(e) => setGrantProtocols(e.target.checked ? null : ["ssh", "rdp", "vnc"])}
        />
        {["ssh", "rdp", "vnc"].map((p) => (
          <Checkbox
            key={p}
            label={p.toUpperCase()}
            checked={grantProtocols === null || grantProtocols.includes(p)}
            disabled={grantProtocols === null}
            onChange={(e) =>
              setGrantProtocols((prev) => {
                const cur = prev ?? ["ssh", "rdp", "vnc"];
                return e.target.checked ? [...new Set([...cur, p])] : cur.filter((x) => x !== p);
              })
            }
          />
        ))}
        <span className="pv-label" style={{ margin: 0 }}>Expires</span>
        <Select
          autoWidth
          small
          value={grantExpiry}
          onChange={(e) => setGrantExpiry(e.target.value)}
          aria-label="Grant expiration"
        >
          <option value="">Never</option>
          <option value="1h">1 hour</option>
          <option value="1d">1 day</option>
          <option value="1w">1 week</option>
          <option value="custom">Custom…</option>
        </Select>
        {grantExpiry === "custom" && (
          <Input
            small
            autoWidth
            type="datetime-local"
            value={customExpiry}
            onChange={(e) => setCustomExpiry(e.target.value)}
            aria-label="Custom expiration"
          />
        )}
      </div>

      <div className="pv-inline">
        {usersQuery.data ? (
          <div style={{ position: "relative" }}>
            <Input
              style={{ width: 256 }}
              placeholder="Search users…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search users to assign"
            />
            {matches.length > 0 && (
              <div className="pv-menu" style={{ width: 256, top: "calc(100% + 4px)", left: 0 }}>
                {matches.map((u) => (
                  <button
                    key={u.id}
                    className="pv-menu-item"
                    style={{ display: "flex", justifyContent: "space-between" }}
                    onClick={() => void assign({ userId: u.id })}
                    disabled={busy}
                  >
                    <span>{u.username}</span>
                    <span className="pv-faint" style={{ fontSize: "0.74rem" }}>{u.roles.join(", ")}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <AssignByUsername onAssign={(username) => void assign({ username })} busy={busy} />
        )}
      </div>
      {usersQuery.isError && (
        <div className="pv-hint" style={{ marginTop: 8 }}>
          User directory unavailable — assign by exact username.
        </div>
      )}
    </Section>
  );
}

function AssignByUsername({ onAssign, busy }: { onAssign: (username: string) => void; busy: boolean }) {
  const [username, setUsername] = useState("");
  return (
    <div className="pv-inline">
      <Input
        style={{ width: 256 }}
        placeholder="Username to assign…"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        aria-label="Username to assign"
      />
      <Btn size="sm" kind="primary" disabled={!username.trim() || busy} onClick={() => onAssign(username.trim())}>
        Assign user
      </Btn>
    </div>
  );
}

/* ============================== invite =============================== */

function InviteSection({ vmId, refresh }: { vmId: string; refresh: () => void }) {
  const toast = useToast();
  const [inviteUser, setInviteUser] = useState("");
  const [busy, setBusy] = useState(false);
  const doInvite = async () => {
    setBusy(true);
    try {
      await api(`/vms/${vmId}/invite`, { method: "POST", body: { username: inviteUser.trim() } });
      toast.ok(`${inviteUser.trim()} now has access`);
      setInviteUser("");
      refresh();
    } catch (err) {
      toast.err("Invite failed", errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Invite someone" hint="Anyone with access can bring one more person in — including an admin on a privacy-flagged VM.">
      <div className="pv-inline">
        <Input
          style={{ width: 224 }}
          placeholder="Username to invite…"
          value={inviteUser}
          onChange={(e) => setInviteUser(e.target.value)}
          aria-label="Username to invite"
        />
        <Btn kind="primary" onClick={() => void doInvite()} disabled={!inviteUser.trim() || busy}>
          Invite
        </Btn>
      </div>
    </Section>
  );
}

/* ============================ share links ============================= */

function VmShareSection({
  vmId,
  connections,
  links,
  refreshShare,
}: {
  vmId: string;
  connections: string[];
  links: Array<{ id: string; protocol: string; expiresAt: string; maxUses: number | null; useCount: number; revokedAt: string | null }>;
  refreshShare: () => void;
}) {
  const toast = useToast();
  const [shareProtocol, setShareProtocol] = useState("");
  const [shareExpiry, setShareExpiry] = useState("60");
  const [shareMaxUses, setShareMaxUses] = useState("");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const active = links.filter((l) => !l.revokedAt && new Date(l.expiresAt).getTime() > Date.now());

  const doShare = async () => {
    if (!shareProtocol) return;
    setBusy(true);
    try {
      const res = await api<{ token: string }>(`/vms/${vmId}/share`, {
        method: "POST",
        body: {
          protocol: shareProtocol,
          expiresInMinutes: Number(shareExpiry),
          maxUses: shareMaxUses ? Number(shareMaxUses) : undefined,
        },
      });
      setShareUrl(`${window.location.origin}/api/s/${res.token}`);
      refreshShare();
    } catch (err) {
      toast.err("Share link failed", errText(err));
    } finally {
      setBusy(false);
    }
  };

  const doRevoke = async (shareId: string) => {
    try {
      await api(`/share/${shareId}`, { method: "DELETE" });
      toast.ok("Share link revoked");
      refreshShare();
    } catch (err) {
      toast.err("Revoke failed", errText(err));
    }
  };

  return (
    <Section
      title="Shareable session links"
      hint="Time-boxed links anyone can open — no account needed. Opening mints a fresh Guacamole session under your identity; revoke anytime."
    >
      <div className="pv-inline" style={{ marginBottom: 12 }}>
        <Select autoWidth small value={shareProtocol} onChange={(e) => setShareProtocol(e.target.value)} aria-label="Protocol to share">
          <option value="">Select protocol…</option>
          {connections.map((p) => (
            <option key={p} value={p}>{p.toUpperCase()}</option>
          ))}
        </Select>
        <Select autoWidth small value={shareExpiry} onChange={(e) => setShareExpiry(e.target.value)} aria-label="Link lifetime">
          <option value="60">1 hour</option>
          <option value="1440">1 day</option>
          <option value="10080">7 days</option>
        </Select>
        <Input
          small
          style={{ width: 120 }}
          placeholder="Max uses (∞)"
          inputMode="numeric"
          value={shareMaxUses}
          onChange={(e) => setShareMaxUses(e.target.value.replace(/[^0-9]/g, ""))}
          aria-label="Maximum uses"
        />
        <Btn size="sm" kind="primary" onClick={() => void doShare()} disabled={!shareProtocol || busy}>
          Create link
        </Btn>
      </div>
      {shareUrl && (
        <Alert kind="ok" title="Share this URL (shown once — copy it now)">
          <code className="pv-mono" style={{ wordBreak: "break-all", userSelect: "all" }}>{shareUrl}</code>
        </Alert>
      )}
      {active.length > 0 ? (
        active.map((l) => (
          <div key={l.id} className="pv-list-row">
            <span className="pv-mono" style={{ textTransform: "uppercase" }}>{l.protocol}</span>
            <span className="pv-faint" style={{ fontSize: "0.8rem" }}>expires {fmtDateTime(l.expiresAt)}</span>
            <span className="pv-faint" style={{ fontSize: "0.8rem" }}>
              used {l.useCount}{l.maxUses === null ? "" : `/${l.maxUses}`}
            </span>
            <span style={{ marginLeft: "auto" }}>
              <button className="pv-btn pv-btn-link" style={{ fontSize: "0.78rem" }} onClick={() => void doRevoke(l.id)}>
                Revoke
              </button>
            </span>
          </div>
        ))
      ) : (
        <EmptyState title="No active share links for this VM" />
      )}
    </Section>
  );
}

/* ============================ job watching ============================ */

function WatchJobButton({ jobId, onProgress }: { jobId: string; onProgress: (v: string) => void }) {
  const [watching, setWatching] = useState(false);
  const watch = () => {
    setWatching(true);
    onProgress("Connecting to job stream…");
    jobEventSource(
      jobId,
      (data) => {
        const d = data as { status: string; step: string | null; message: string };
        onProgress(`${d.status}${d.step ? ` (${d.step})` : ""}: ${d.message}`);
      },
      () => {
        onProgress("");
        setWatching(false);
      },
      (err) => {
        onProgress(`Event stream unavailable: ${err.message}`);
        setWatching(false);
      },
    );
  };
  return (
    <Btn size="sm" onClick={watch} disabled={watching}>
      {watching ? "Watching…" : "Watch"}
    </Btn>
  );
}

/* ============================== graphs =============================== */

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
          <span className="pv-faint">no data</span>
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
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title} over the selected range. Current value ${current}.`}
        style={{ width: "100%", height: 128, background: "var(--pv-inset)", border: "1px solid var(--pv-border-soft)", borderRadius: 6 }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--pv-border)" strokeWidth="1" />
        ))}
        <polygon points={area} fill={color} opacity="0.16" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" />
        {series2 && color2 && (
          <polyline points={toLine(series2)} fill="none" stroke={color2} strokeWidth="1.5" strokeDasharray="4 2" />
        )}
        {ticks.map((t) => (
          <text key={t.label} x={t.x} y={H - 1} fontSize="9" fill="var(--pv-text-3)" textAnchor="middle">
            {t.label}
          </text>
        ))}
        <text x={W - 3} y={12} fontSize="9" fill="var(--pv-text-3)" textAnchor="end">
          max {format(top)}
        </text>
      </svg>
      {label2 && <div style={{ fontSize: 10, color: "var(--pv-text-3)", marginTop: 4 }}>solid: primary · dashed {label2}</div>}
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
      hint="RRD metrics reported by Proxmox"
      actions={
        <Select
          autoWidth
          small
          value={timeframe}
          onChange={(e) => setTimeframe(e.target.value)}
          aria-label="Time range"
        >
          {["hour", "day", "week", "month"].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </Select>
      }
    >
      {!rows.length ? (
        <EmptyState title="No data points yet for this range" body="Graphs fill in once the guest reports metrics." />
      ) : (
        <div className="pv-grid-2">
          <MetricChart
            title={`CPU${last && last.maxcpu > 0 ? ` (${last.maxcpu} cores)` : ""}`}
            current={`${cpuPct.toFixed(1)}%`}
            color="var(--pv-accent)"
            format={(v) => `${v.toFixed(1)}%`}
            series={rows.map((r) => ({ t: r.t, v: r.maxcpu > 0 ? (r.cpu / r.maxcpu) * 100 : r.cpu * 100 }))}
          />
          <MetricChart
            title={`Memory (${fmtBytes(last?.maxmem ?? 0)} total)`}
            current={`${fmtBytes(last?.mem ?? 0)} · ${memPct.toFixed(0)}%`}
            color="var(--pv-ok)"
            format={(v) => fmtBytes(v)}
            series={rows.map((r) => ({ t: r.t, v: r.mem }))}
          />
          <MetricChart
            title="Network in / out"
            current={`↓ ${fmtBytes(last?.netin ?? 0)}/s · ↑ ${fmtBytes(last?.netout ?? 0)}/s`}
            color="#38bdf8"
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
