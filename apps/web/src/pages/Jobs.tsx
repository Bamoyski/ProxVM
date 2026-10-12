import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, jobEventSource } from "../api.js";
import { makeCan, useEffectivePermissions } from "../iam.js";
import { PageTitle, StatusBadge, Empty, Btn } from "../components/ui.js";

interface Job {
  id: string;
  vmId: string | null;
  status: string;
  error: string | null;
  createdByUserId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface Me {
  id: string;
  username: string;
  roles: string[];
}

function hasPermission(me: Me, perm: string): boolean {
  const rolePerms: Record<string, string[]> = {
    ADMIN: ["jobs.read", "jobs.retry", "jobs.cancel", "vm.delete"],
    OPERATOR: ["jobs.read", "jobs.retry", "jobs.cancel"],
    USER: ["jobs.read"],
  };
  return me.roles.some((r) => rolePerms[r]?.includes(perm));
}

export default function Jobs({ me }: { me: Me }) {
  const { jobId } = useParams();
  const can = makeCan(useEffectivePermissions(), (perm) => hasPermission(me, perm));
  const canRetry = can("jobs.retry");
  const canCancel = can("jobs.cancel");
  const canRollback = can("vm.delete");
  const qc = useQueryClient();
  const { data: jobs } = useQuery({
    queryKey: ["jobs", jobId],
    queryFn: () => api<{ jobs: Job[] }>(`/jobs?limit=100${jobId ? "" : ""}`),
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
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const cancel = async (id: string) => {
    try {
      await api(`/jobs/${id}/cancel`, { method: "POST", body: {} });
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const rollback = async (id: string, action: "delete" | "keep") => {
    try {
      await api(`/jobs/${id}/rollback`, { method: "POST", body: { action } });
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="pv-page">
      <PageTitle
        title="Provisioning jobs"
        description="Each provisioning run is a tracked job. Watch live progress, retry failures, or roll back."
      />
      {progress && <div className="pv-notice pv-mono" style={{ fontSize: "0.8rem" }}>{progress}</div>}
      <div className="pv-table-wrap">
        <table className="pv-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Created</th>
              <th>Finished</th>
              <th>Error</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(jobs?.jobs ?? []).map((j) => (
              <tr key={j.id}>
                <td className="pv-mono">{j.id.slice(0, 8)}…</td>
                <td><StatusBadge status={j.status} /></td>
                <td style={{ color: "var(--pv-text-2)" }}>{new Date(j.createdAt).toLocaleString()}</td>
                <td style={{ color: "var(--pv-text-2)" }}>{j.finishedAt ? new Date(j.finishedAt).toLocaleString() : "—"}</td>
                <td style={{ color: "var(--pv-err)", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={j.error ?? undefined}>{j.error ?? "—"}</td>
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
        <Empty title="No jobs yet" body="Provisioning a VM from a template creates a tracked job here." />
      )}
    </div>
  );
}
