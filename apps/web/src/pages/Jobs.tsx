import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, jobEventSource } from "../api.js";
import { makeCan, useEffectivePermissions } from "../iam.js";
import { hasPermission, type Me } from "../lib/permissions.js";
import { fmtDateTime } from "../lib/format.js";
import { PageHeader, StatusBadge, EmptyState, Btn, Alert, useConfirm, useToast, errText } from "../ui/index.js";

interface Job {
  id: string;
  vmId: string | null;
  status: string;
  error: string | null;
  createdByUserId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/**
 * Provisioning job list. `bare` embeds the full list (watch/retry/cancel/
 * rollback) inside another page — the Dashboard — without page chrome.
 */
export default function Jobs({ me, bare }: { me: Me; bare?: boolean }) {
  const { jobId } = useParams();
  const can = makeCan(useEffectivePermissions(), (perm) => hasPermission(me, perm));
  const canRetry = can("jobs.retry");
  const canCancel = can("jobs.cancel");
  const canRollback = can("vm.delete");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: jobs } = useQuery({
    queryKey: ["jobs", jobId],
    queryFn: () => api<{ jobs: Job[] }>(`/jobs?limit=100`),
    refetchInterval: 10000,
  });
  const [progress, setProgress] = useState<string | null>(null);

  const watch = (id: string) => {
    setProgress("Connecting…");
    jobEventSource(
      id,
      (d) => {
        const data = d as { status: string; step: string | null; message: string };
        setProgress(`${data.status}${data.step ? ` (${data.step})` : ""}: ${data.message}`);
      },
      () => setProgress(null),
      (err) => setProgress(`Event stream unavailable: ${err.message}`),
    );
  };

  const retry = async (id: string) => {
    try {
      await api(`/jobs/${id}/retry`, { method: "POST", body: {} });
      toast.info("Retry queued", "The job restarts from its first incomplete step.");
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (err) {
      toast.err("Retry failed", errText(err));
    }
  };

  const cancel = async (id: string) => {
    const ok = await confirm({
      title: "Cancel this job?",
      confirmLabel: "Cancel job",
      body: "The worker stops between steps. Resources already created (partial VM, credential) may need a rollback.",
    });
    if (!ok) return;
    try {
      await api(`/jobs/${id}/cancel`, { method: "POST", body: {} });
      toast.info("Cancellation requested");
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (err) {
      toast.err("Cancel failed", errText(err));
    }
  };

  const rollback = async (id: string, action: "delete" | "keep") => {
    const ok = await confirm({
      title: action === "delete" ? "Roll back and delete the partial VM?" : "Keep the partial VM for debugging?",
      danger: action === "delete",
      requireText: action === "delete" ? "DELETE" : undefined,
      confirmLabel: action === "delete" ? "Roll back" : "Keep",
      body:
        action === "delete"
          ? "Removes resources the failed job created. The job record stays for the audit trail."
          : "Marks the job rolled back without deleting anything — inspect the partial VM, then clean up manually.",
    });
    if (!ok) return;
    try {
      await api(`/jobs/${id}/rollback`, { method: "POST", body: { action } });
      toast.info(action === "delete" ? "Rollback started" : "Job marked kept");
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["vms"] });
    } catch (err) {
      toast.err("Rollback failed", errText(err));
    }
  };

  const body = (
    <>
      {progress && (
        <Alert kind="info" title="Live job progress">
          <code className="pv-mono" style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>{progress}</code>
        </Alert>
      )}
      <div className="pv-table-wrap">
        <table className="pv-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Created</th>
              <th className="pv-hide-md">Finished</th>
              <th className="pv-hide-sm">Error</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(jobs?.jobs ?? []).map((j) => (
              <tr key={j.id}>
                <td className="pv-mono">{j.id.slice(0, 8)}…</td>
                <td><StatusBadge status={j.status} animate={!["READY", "FAILED", "CANCELLED"].includes(j.status)} /></td>
                <td className="pv-faint">{fmtDateTime(j.createdAt)}</td>
                <td className="pv-faint pv-hide-md">{j.finishedAt ? fmtDateTime(j.finishedAt) : "—"}</td>
                <td
                  className="pv-hide-sm"
                  style={{ color: "var(--pv-err)", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={j.error ?? undefined}
                >
                  {j.error ?? "—"}
                </td>
                <td>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {!["READY", "FAILED", "CANCELLED"].includes(j.status) && (
                      <>
                        <Btn size="sm" kind="link" onClick={() => watch(j.id)}>Watch</Btn>
                        {canCancel && (
                          <Btn size="sm" kind="link" onClick={() => void cancel(j.id)}>Cancel</Btn>
                        )}
                      </>
                    )}
                    {["FAILED", "CANCELLED"].includes(j.status) && (
                      <>
                        {canRetry && (
                          <Btn size="sm" onClick={() => void retry(j.id)}>Retry</Btn>
                        )}
                        {canRollback && (
                          <>
                            <Btn size="sm" kind="link" onClick={() => void rollback(j.id, "keep")}>Keep for debugging</Btn>
                            <Btn size="sm" kind="link" onClick={() => void rollback(j.id, "delete")}>Delete VM</Btn>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!jobs?.jobs.length && (
        <EmptyState
          title="No jobs yet"
          body="Provisioning a VM from a template creates a tracked job here."
        />
      )}
    </>
  );

  if (bare) return <>{body}</>;

  return (
    <div className="pv-page">
      <PageHeader
        title="Provisioning jobs"
        description="Each provisioning run is a tracked job. Watch live progress, retry failures, or roll back."
      />
      {body}
    </div>
  );
}
