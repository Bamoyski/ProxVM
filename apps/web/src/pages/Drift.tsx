import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { RefreshCw, CheckCheck, Undo2, Trash2, ServerOff, ArrowRightLeft } from "lucide-react";
import { api } from "../api.js";
import { fmtDateTime } from "../lib/format.js";
import {
  PageHeader,
  EmptyState,
  Badge,
  Btn,
  Select,
  TableSkeleton,
  Alert,
  useToast,
  errText,
  useConfirm,
  type BadgeTone,
} from "../ui/index.js";

/**
 * Drift board: ground-truth reconciliation findings. Read-only detection
 * runs server-side (ticker or the Run pass button); every mutation here is
 * an explicit, confirmed human action. Decommission is destructive and
 * requires typing the VM name (see confirm below).
 */

interface DriftFinding {
  id: string;
  fingerprint: string;
  dimension: "deleted" | "config" | "hw" | "ip" | "guac" | "credential";
  severity: "critical" | "high" | "medium" | "low";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  vmId: string | null;
  vmName?: string | null;
  vmid?: number | null;
  connectionId?: string | null;
  title: string;
  summary: string;
  detail: Record<string, unknown>;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  acknowledgedAt?: string | null;
}

interface DriftLastRun {
  at: string;
  skipped: string | null;
  liveChecked: boolean;
  created: number;
  updated: number;
  resolved: number;
  exempted: number;
}

type RemediationAction = "adopt" | "resync_ip" | "decommission" | "delete_orphan_connection";

const SEVERITY_TONE: Record<DriftFinding["severity"], BadgeTone> = {
  critical: "err",
  high: "warn",
  medium: "info",
  low: "neutral",
};

const DIMENSION_LABELS: Record<DriftFinding["dimension"], string> = {
  deleted: "Deleted (out-of-band)",
  config: "Config",
  hw: "Hardware",
  ip: "IP address",
  guac: "Orphaned connection",
  credential: "Credential",
};

/** Which remediations make sense per dimension (the backend re-verifies
 * everything and refuses stale findings regardless of what the UI offers). */
function remediationFor(f: DriftFinding): RemediationAction | null {
  switch (f.dimension) {
    case "deleted":
      return f.status === "OPEN" || f.status === "ACKNOWLEDGED" ? "decommission" : null;
    case "config":
    case "hw":
      return "adopt";
    case "ip":
      return "resync_ip";
    case "guac":
      return "delete_orphan_connection";
    default:
      return null; // credential drift has no auto-fix: rotate the credential
  }
}

function VmLink({ f }: { f: DriftFinding }) {
  if (!f.vmId) return <span className="pv-faint">—</span>;
  return (
    <Link to={f.status === "RESOLVED" ? `/vms` : `/vms/${f.vmId}`} className="pv-link">
      {f.vmName ?? f.vmId.slice(0, 8)}
      {f.vmid != null ? <span className="pv-faint"> ({f.vmid})</span> : null}
    </Link>
  );
}

export default function Drift() {
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [statusFilter, setStatusFilter] = useState<"" | "OPEN" | "ACKNOWLEDGED" | "RESOLVED">("");
  const [running, setRunning] = useState(false);

  const board = useQuery({
    queryKey: ["drift", statusFilter],
    queryFn: () =>
      api<{ findings: DriftFinding[]; lastRun: DriftLastRun | null; evaluatedAt: string }>(
        `/drift${statusFilter ? `?status=${statusFilter}` : ""}`,
      ),
    refetchInterval: 30_000,
  });

  const act = useMutation({
    mutationFn: ({
      finding,
      action,
      confirmText,
    }: {
      finding: DriftFinding;
      action: RemediationAction | "acknowledge";
      /** Server-side confirmation token for the destructive actions. The
       *  browser prompt is a second line of defence; the API enforces the
       *  token itself. */
      confirmText?: string;
    }) =>
      action === "acknowledge"
        ? api<{ status: string }>(`/drift/findings/${finding.id}/acknowledge`, { method: "POST", body: {} })
        : api<{ status: string }>(`/drift/findings/${finding.id}/remediate`, {
            method: "POST",
            body: confirmText ? { action, confirmText } : { action },
          }),
    onSuccess: (_r, v) => {
      toast.ok(
        v.action === "acknowledge" ? "Finding acknowledged" : "Remediation applied",
        "The change was verified against the live infrastructure and recorded in the audit log.",
      );
      void qc.invalidateQueries({ queryKey: ["drift"] });
    },
    onError: (err, v) => {
      toast.err(v.action === "acknowledge" ? "Acknowledge failed" : "Remediation refused", errText(err));
      // A refused action usually means the finding went stale — refresh the board.
      void qc.invalidateQueries({ queryKey: ["drift"] });
    },
  });

  const runPass = useMutation({
    mutationFn: () => api<{ created: number; resolved: number; skipped: string | null }>("/drift/run", { method: "POST", body: {} }),
    onSuccess: (r) => {
      if (r.skipped) {
        toast.info("Drift pass skipped", `Reason: ${r.skipped}. Fix infrastructure access and try again.`);
      } else {
        toast.ok("Drift pass complete", `${r.created} new, ${r.resolved} auto-resolved.`);
      }
      void qc.invalidateQueries({ queryKey: ["drift"] });
    },
    onError: (err) => toast.err("Drift pass failed", errText(err)),
  });

  const remediate = async (f: DriftFinding): Promise<void> => {
    const action = remediationFor(f);
    if (!action) return;
    let confirmText: string | undefined;
    if (action === "decommission") {
      const label =
        f.vmName ?? (f.detail.vmid != null ? `vmid ${String(f.detail.vmid)}` : "this record");
      const typed = `DECOMMISSION ${label}`;
      // Destructive: removes ProxVM's record for a VM that may still be
      // running out-of-band. The backend re-verifies and refuses if the
      // guest reappeared or a job is active; typing guards fat fingers.
      const ok = await confirm({
        title: "Decommission record",
        danger: true,
        body: (
          <>
            <p>
              This deletes ProxVM's record for <strong>{f.vmName ?? "the missing VM"}</strong>
              {f.vmid != null ? ` (vmid ${f.vmid})` : ""} and its Guacamole connections. The VM is
              already gone from Proxmox. This cannot be undone — re-adding the VM later means a
              full re-provision or manual re-import.
            </p>
            <p className="pv-muted">Type <code className="pv-mono">{typed}</code> to confirm.</p>
          </>
        ),
        confirmLabel: "Decommission",
        requireText: typed,
      });
      if (!ok) return;
      // The API enforces this token itself; the prompt is a second line of
      // defence, not the control.
      confirmText = typed;
    } else if (action === "delete_orphan_connection") {
      const ok = await confirm({
        title: "Delete orphan connection",
        danger: true,
        body: `Deletes the leftover Guacamole connection record ("${String(f.detail.guacConnectionName ?? f.connectionId ?? "")}") whose VM no longer exists.`,
        confirmLabel: "Delete record",
        requireText: "DELETE",
      });
      if (!ok) return;
    } else {
      const copy: Record<string, string> = {
        adopt: `Adopts the live state ${f.dimension === "hw" ? "into the hardware baseline" : "into ProxVM's record"} — no VM change is made.`,
        resync_ip: `Re-syncs the recorded IP to the address the guest agent reports now.`,
      };
      const ok = await confirm({ title: "Apply remediation", body: copy[action], confirmLabel: "Apply" });
      if (!ok) return;
    }
    act.mutate({ finding: f, action, confirmText });
  };

  const acknowledge = async (f: DriftFinding): Promise<void> => {
    act.mutate({ finding: f, action: "acknowledge" });
  };

  const lastRun = board.data?.lastRun ?? null;
  const findings = board.data?.findings ?? [];
  const actionable = findings.filter((f) => f.status !== "RESOLVED");

  return (
    <div className="pv-page">
      <PageHeader
        title="Drift"
        description="Ground-truth reconciliation: what ProxVM records vs. what Proxmox, the guest agents and Guacamole actually report. Detection is automatic; remediation is always manual."
        actions={
          <>
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              autoWidth
              aria-label="Filter findings by status"
            >
              <option value="">Active findings</option>
              <option value="OPEN">Open</option>
              <option value="ACKNOWLEDGED">Acknowledged</option>
              <option value="RESOLVED">Resolved (history)</option>
            </Select>
            <Btn size="sm" onClick={() => runPass.mutate()} loading={runPass.isPending}>
              <RefreshCw size={14} className={runPass.isPending ? "pv-spin" : undefined} /> Run pass now
            </Btn>
          </>
        }
      />

      {lastRun && !lastRun.liveChecked && lastRun.skipped && (
        <Alert kind="warn" title="Last pass was skipped">
          Reason: <code className="pv-mono">{lastRun.skipped}</code>. Nothing was checked and nothing changed —
          this surface never acts on unverified state.
        </Alert>
      )}

      {lastRun && lastRun.exempted > 0 && (
        <Alert kind="info" title={`${lastRun.exempted} VM(s) exempted in the last pass`}>
          VMs with active provisioning jobs are exempt from drift comparison — mid-provision state legitimately
          disagrees with the record.
        </Alert>
      )}

      {findings.length === 0 ? (
        <EmptyState
          
          title="No drift detected"
          body={
            board.data
              ? "ProxVM's records agree with the live infrastructure. Findings appear here automatically when they disagree."
              : "Loading the board…"
          }
        />
      ) : (
        <div className="pv-panel">
          <table className="pv-table">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Resource</th>
                <th>Finding</th>
                <th>Severity</th>
                <th>Status</th>
                <th>Occurrences</th>
                <th>Last seen</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => {
                const action = remediationFor(f);
                return (
                  <tr key={f.id}>
                    <td><Badge tone={SEVERITY_TONE[f.severity]}>{DIMENSION_LABELS[f.dimension]}</Badge></td>
                    <td><VmLink f={f} /></td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{f.title}</div>
                      <div className="pv-muted">{f.summary}</div>
                      {f.dimension === "config" && (
                        <div className="pv-mono pv-faint">
                          {String(f.detail.field)}: {String(f.detail.recorded)} → {String(f.detail.live)}
                        </div>
                      )}
                      {f.dimension === "hw" && (
                        <div className="pv-mono pv-faint">
                          {String(f.detail.field)}: {String(f.detail.recorded)} → {String(f.detail.live)}
                        </div>
                      )}
                      {f.dimension === "ip" && (
                        <div className="pv-mono pv-faint">
                          {String(f.detail.recorded)} → {String(f.detail.live)}
                        </div>
                      )}
                    </td>
                    <td><Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge></td>
                    <td>
                      <Badge tone={f.status === "RESOLVED" ? "ok" : f.status === "ACKNOWLEDGED" ? "info" : "warn"}>
                        {f.status.toLowerCase()}
                      </Badge>
                    </td>
                    <td className="pv-mono">{f.occurrences}</td>
                    <td className="pv-faint">{fmtDateTime(f.lastSeen)}</td>
                    <td>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        {f.status !== "RESOLVED" && (
                          <>
                            {action === "decommission" && (
                              <Btn size="sm" kind="danger" onClick={() => void remediate(f)}>
                                <ServerOff size={14} /> Decommission
                              </Btn>
                            )}
                            {action === "adopt" && (
                              <Btn size="sm" onClick={() => void remediate(f)}>
                                <CheckCheck size={14} /> Adopt
                              </Btn>
                            )}
                            {action === "resync_ip" && (
                              <Btn size="sm" onClick={() => void remediate(f)}>
                                <ArrowRightLeft size={14} /> Re-sync IP
                              </Btn>
                            )}
                            {action === "delete_orphan_connection" && (
                              <Btn size="sm" kind="danger" onClick={() => void remediate(f)}>
                                <Trash2 size={14} /> Delete orphan
                              </Btn>
                            )}
                            {f.status === "OPEN" && (
                              <Btn size="sm" kind="ghost" onClick={() => void acknowledge(f)}>
                                <Undo2 size={14} /> Acknowledge
                              </Btn>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {actionable.length > 0 && (
            <div className="pv-muted" style={{ padding: "8px 12px", fontSize: "0.8rem" }}>
              Acknowledged findings stay visible until the drift actually clears; they auto-resolve once the
              discrepancy disappears. Every remediation is re-verified against live state right before it runs.
            </div>
          )}
        </div>
      )}

      {board.isLoading && <TableSkeleton rows={4} />}
      {board.isError && <Alert kind="err" title="Board failed to load">{errText(board.error)}</Alert>}
    </div>
  );
}
