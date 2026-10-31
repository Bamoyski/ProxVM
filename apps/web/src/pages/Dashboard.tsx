import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Check, ChevronDown, ChevronUp, LifeBuoy, ShieldAlert } from "lucide-react";
import { api } from "../api.js";
import { useAttention } from "../hooks/attention.js";
import { attentionItems } from "../lib/attention.js";
import Jobs from "./Jobs.js";
import { isPrivileged, type Me } from "../lib/permissions.js";
import { fmtBytes, fmtDateTime, pct } from "../lib/format.js";
import {
  PageHeader, StatusBadge, EmptyState, Section, Btn, Alert, Stat, Meter, utilTone, useToast, errText,
} from "../ui/index.js";

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

type WidgetId = "stats" | "proxmox" | "discovery" | "events" | "jobs" | "drift" | "mine";

const ALL_WIDGETS: Array<{ id: WidgetId; title: string }> = [
  { id: "stats", title: "Overview" },
  { id: "mine", title: "My activity" },
  { id: "proxmox", title: "Cluster & balance" },
  { id: "discovery", title: "Discovered services" },
  { id: "events", title: "Recent events" },
  { id: "jobs", title: "Recent provisioning jobs" },
  { id: "drift", title: "Drift (ground-truth)" },
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

export default function Dashboard({ me, can }: { me: Me; can?: (perm: string) => boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const privileged = isPrivileged(me.roles);
  // Self-serve GUEST accounts hold zero permissions: without vm.list there
  // is no dashboard to show — every widget would just be a 403 error box.
  // The explicit "awaiting access" state replaces all of it until an admin
  // grants roles.
  const canList = can ? can("vm.list") : true;
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const [customizing, setCustomizing] = useState(false);

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
    queryFn: () => api<{ connected: boolean; version?: string; nodes?: NodeStatus[]; error?: string }>("/proxmox/status"),
    refetchInterval: 15000,
    enabled: privileged,
  });
  const { data: vmsData } = useQuery({
    queryKey: ["vms"],
    queryFn: () => api<{ vms: Array<VmRow & { guacamole: { created: boolean } | null; credentialStatus: string | null }> }>("/vms"),
    refetchInterval: 15000,
    enabled: canList,
  });
  const { data: jobs } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<{ jobs: Array<{ id: string; status: string; error: string | null; createdAt: string }> }>("/jobs?limit=5"),
    refetchInterval: 10000,
    enabled: canList,
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
    enabled: canList,
  });
  const { data: mine } = useQuery({
    queryKey: ["my-activity"],
    queryFn: () => api<{ activity: Array<{ id: string; event: string; vmId: string | null; createdAt: string }> }>("/me/activity"),
    refetchInterval: 30000,
  });
  const canDrift = can ? can("drift.manage") : false;
  const { data: driftBoard } = useQuery({
    queryKey: ["drift-summary"],
    // Active findings only (no status filter = default board).
    queryFn: () =>
      api<{ findings: Array<{ id: string; severity: "critical" | "high" | "medium" | "low"; status: string }>; lastRun: { liveChecked: boolean; skipped: string | null } | null; enabled: boolean }>(
        "/drift",
      ),
    refetchInterval: 60000,
    enabled: canDrift,
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
    try {
      await api("/discovery/run", { method: "POST", body: {} });
      toast.info("Discovery scan started", "Results appear below once the scan finishes.");
      void qc.invalidateQueries({ queryKey: ["vm-services"] });
    } catch (err) {
      toast.err("Discovery scan failed", errText(err));
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

  const canAuditAttention = can ? can("audit.read") : privileged;
  const canManageUsersAttention = can ? can("users.manage") : privileged;
  // Shares the ["attention"] query key with the sidebar badges: an admin who
  // loads the dashboard pays for exactly one request.
  const { data: attention } = useAttention(canAuditAttention || canManageUsersAttention);
  const needsAttention = attentionItems(attention);

  const statItems: Array<{ label: string; value: string; tone?: string }> = [
    { label: "Total VMs", value: String(vmList.length) },
    { label: "Running", value: String(running), tone: "var(--pv-ok)" },
    { label: "Stopped", value: String(stopped) },
    ...(failed ? [{ label: "Failed", value: String(failed), tone: "var(--pv-err)" }] : []),
    ...(activeJobs ? [{ label: "Active jobs", value: String(activeJobs), tone: "var(--pv-accent)" }] : []),
  ];

  const widgets: Record<WidgetId, { privilegedOnly: boolean; node: React.ReactNode }> = {
    mine: {
      privilegedOnly: false,
      node: (
        <Section title="My activity" hint="Your launches, backups, and changes — newest first.">
          {(mine?.activity ?? []).map((a) => (
            <div
              key={a.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                padding: "7px 0",
                borderBottom: "1px solid var(--pv-border-soft)",
                fontSize: "0.85rem",
              }}
            >
              <span className="pv-mono">{a.event}</span>
              <span className="pv-faint" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(a.createdAt)}</span>
            </div>
          ))}
          {!(mine?.activity ?? []).length && (
            <EmptyState title="Nothing yet" body="Your launches, backups, and changes will appear here." />
          )}
        </Section>
      ),
    },
    stats: {
      privilegedOnly: false,
      node: (
        <Section title="Overview" hint="Fleet counters, live">
          <div className="pv-grid-stats">
            {statItems.map((s) => (
              <Stat key={s.label} label={s.label} value={s.value} tone={s.tone} />
            ))}
          </div>
        </Section>
      ),
    },
    proxmox: {
      privilegedOnly: true,
      node: (
        <Section
          title={`Cluster${pm?.connected && pm.version ? ` — Proxmox VE ${pm.version}` : ""}`}
          hint={!pm?.connected ? "disconnected" : undefined}
        >
          {pmError && <Alert kind="err" title="Failed to load Proxmox status">{errText(pmError)}</Alert>}
          {!pm?.connected && pm && (
            <Alert kind="warn" title="Proxmox disconnected">{pm.error ?? "unknown error"}</Alert>
          )}
          {nodes.map((n) => {
            const cpu = pct(n.cpu, n.maxcpu) ?? 0;
            const mem = pct(n.mem, n.maxmem) ?? 0;
            return (
              <div key={n.node} style={{ padding: "11px 0", borderBottom: "1px solid var(--pv-border-soft)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 7 }}>
                  <span style={{ fontWeight: 600, display: "inline-flex", gap: 8, alignItems: "center" }}>
                    {n.node} <StatusBadge status={n.status === "online" ? "running" : "stopped"} />
                  </span>
                  <span className="pv-faint pv-mono" style={{ fontSize: "0.78rem" }}>
                    {cpu.toFixed(0)}% CPU · {fmtBytes(n.mem)}/{fmtBytes(n.maxmem)} RAM
                  </span>
                </div>
                <div style={{ display: "grid", gap: 5 }}>
                  <Meter value={cpu} max={100} tone={utilTone(cpu)} title={`${n.node} CPU ${cpu.toFixed(0)}%`} />
                  <Meter value={mem} max={100} tone={utilTone(mem)} title={`${n.node} RAM ${mem.toFixed(0)}%`} />
                </div>
              </div>
            );
          })}
          {showTip && balanceTip && (
            <Alert kind="warn" title="Balance suggestion">
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <span style={{ flex: 1 }}>{balanceTip}</span>
                <button
                  className="pv-btn pv-btn-link"
                  style={{ fontSize: "0.78rem", flex: "none" }}
                  onClick={dismissTip}
                  title="Hide this suggestion (it returns if the situation changes)"
                >
                  Dismiss
                </button>
              </div>
            </Alert>
          )}
        </Section>
      ),
    },
    discovery: {
      privilegedOnly: false,
      node: (
        <Section
          title="Discovered services"
          hint="Open ports mapped to their VMs by the last scan."
          actions={privileged ? <Btn size="sm" onClick={() => void runDiscovery()}>Scan now</Btn> : undefined}
        >
          {[...servicesByVm.entries()].map(([vmId, services]) => {
            const vm = vmList.find((v) => v.id === vmId);
            if (!vm) return null;
            return (
              <div
                key={vmId}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 0",
                  borderBottom: "1px solid var(--pv-border-soft)",
                  fontSize: "0.85rem",
                }}
              >
                <Link to={`/vms/${vmId}`} style={{ fontWeight: 550 }}>{vm.name}</Link>
                {services.map((s) => (
                  <span key={s.port} className="pv-mono" title={`Port ${s.port}`} style={{ color: "var(--pv-text-2)" }}>
                    {s.service} · {s.port}
                  </span>
                ))}
              </div>
            );
          })}
          {!servicesByVm.size && (
            <EmptyState
              title="No scan results yet"
              body={privileged ? "Run a discovery scan to map open services to VMs." : "An administrator runs the scan."}
            />
          )}
        </Section>
      ),
    },
    events: {
      privilegedOnly: true,
      node: (
        <Section title="Recent events" hint="Last 10 audit entries across the fleet.">
          {(audit?.entries ?? []).map((e) => (
            <div
              key={e.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                padding: "7px 0",
                borderBottom: "1px solid var(--pv-border-soft)",
                fontSize: "0.85rem",
              }}
            >
              <span className="pv-mono">{e.event}</span>
              <span className="pv-faint" style={{ whiteSpace: "nowrap" }}>
                {e.actorUsername ?? "system"} · {fmtDateTime(e.createdAt)}
              </span>
            </div>
          ))}
          {!audit?.entries.length && <EmptyState title="No events yet" body="Actions across the fleet will appear here." />}
        </Section>
      ),
    },
    jobs: {
      privilegedOnly: false,
      node: (
        <Section title="Provisioning jobs" hint="Watch live progress, retry failures, roll back.">
          <Jobs me={me} bare />
        </Section>
      ),
    },
    drift: {
      privilegedOnly: true,
      node: (() => {
        const active = (driftBoard?.findings ?? []).filter((f) => f.status !== "RESOLVED");
        const bySeverity = (s: "critical" | "high" | "medium" | "low") =>
          active.filter((f) => f.severity === s).length;
        const skipped = driftBoard?.lastRun && !driftBoard.lastRun.liveChecked ? driftBoard.lastRun.skipped : null;
        // The feature can be switched off entirely. An empty widget then means
        // "nothing was checked", not "nothing is wrong" — say so, or the
        // operator reads a clean board on a system that is not being watched.
        const disabled = driftBoard ? driftBoard.enabled === false : false;
        return (
          <Section title="Drift (ground truth)" hint="Recorded state vs. live infrastructure — remediation is manual.">
            {active.length === 0 ? (
              <EmptyState
                title={disabled ? "Drift detection is disabled" : skipped ? "Last pass skipped" : "No drift detected"}
                body={
                  disabled
                    ? "Nothing has been checked — the pass never runs while the feature is off. Enable it in Settings → Application."
                    : skipped
                      ? `Reason: ${skipped}. Nothing was changed — run a pass or check infrastructure access.`
                      : "Records agree with Proxmox and Guacamole. New discrepancies surface here automatically."
                }
              />
            ) : (
              <>
                {disabled && (
                  <Alert kind="warn" title="Drift detection is disabled">
                    The pass is not running — these findings are from the last time it did.
                  </Alert>
                )}
                {skipped && <Alert kind="warn" title="Last pass was skipped">Reason: {skipped}.</Alert>}
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", padding: "8px 0" }}>
                  <Stat label="Critical" value={String(bySeverity("critical"))} tone={bySeverity("critical") > 0 ? "err" : undefined} />
                  <Stat label="High" value={String(bySeverity("high"))} tone={bySeverity("high") > 0 ? "err" : "warn"} />
                  <Stat label="Medium" value={String(bySeverity("medium"))} tone="warn" />
                  <Stat label="Low" value={String(bySeverity("low"))} tone="ok" />
                </div>
                <div style={{ padding: "6px 0" }}>
                  <Link to="/system?tab=drift" className="pv-link">Review on the Drift board →</Link>
                </div>
              </>
            )}
          </Section>
        );
      })(),
    },
  };

  if (!canList) {
    return (
      <div className="pv-page pv-page-narrow">
        <PageHeader title="Dashboard" description="Your account is active but has no VM access yet." />
        <Section title="Welcome">
          <EmptyState
            title="Awaiting VM access"
            body="Your account was created with no permissions. An administrator will grant access — once VMs are assigned to you, they appear here along with remote-access buttons and credentials."
          />
        </Section>
      </div>
    );
  }

  return (
    <div className="pv-page">
      <PageHeader
        title="Dashboard"
        description={privileged ? "Fleet state at a glance. Rearrange or hide sections with Customize." : "Your virtual machines and recent activity."}
        actions={<Btn size="sm" onClick={() => setCustomizing((v) => !v)}>{customizing ? "Done" : "Customize"}</Btn>}
      />
      {needsAttention.length > 0 && (
        <div className="pv-attention" role="region" aria-label="Needs attention">
          {needsAttention.map((item) => (
            <Link key={item.key} to={item.to} className={`pv-attention-card pv-attention-${item.tone}`}>
              <span className="pv-attention-ico" aria-hidden="true">
                {item.key === "threats" ? <ShieldAlert size={16} /> : <LifeBuoy size={16} />}
              </span>
              <span className="pv-attention-body">
                <span className="pv-attention-title">{item.title}</span>
                <span className="pv-attention-detail">{item.detail}</span>
              </span>
              <span className="pv-attention-cta">{item.cta} →</span>
            </Link>
          ))}
        </div>
      )}
      {customizing && (
        <div className="pv-panel" style={{ marginBottom: 20 }}>
          <div className="pv-label" style={{ marginBottom: 10 }}>Arrange sections (saved in this browser)</div>
          {layout.order.map((id) => (
            <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", fontSize: "0.85rem" }}>
              <button
                onClick={() => toggleWidget(id)}
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  border: `1px solid ${layout.hidden.includes(id) ? "var(--pv-border)" : "var(--pv-accent)"}`,
                  background: layout.hidden.includes(id) ? "transparent" : "var(--pv-accent)",
                  color: "#fff",
                  fontSize: 10,
                  lineHeight: 1,
                  cursor: "pointer",
                }}
                aria-label={`Toggle ${ALL_WIDGETS.find((w) => w.id === id)?.title}`}
                aria-pressed={!layout.hidden.includes(id)}
              >
                <Check size={11} strokeWidth={3} aria-hidden="true" />
              </button>
              <span style={{ color: layout.hidden.includes(id) ? "var(--pv-text-3)" : "var(--pv-text)" }}>
                {ALL_WIDGETS.find((w) => w.id === id)?.title}
              </span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                <Btn size="sm" kind="link" onClick={() => moveWidget(id, -1)} aria-label="Move widget up">
                  <ChevronUp size={14} aria-hidden="true" />
                </Btn>
                <Btn size="sm" kind="link" onClick={() => moveWidget(id, 1)} aria-label="Move widget down">
                  <ChevronDown size={14} aria-hidden="true" />
                </Btn>
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
