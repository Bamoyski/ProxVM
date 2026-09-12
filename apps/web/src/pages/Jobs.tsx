import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, jobEventSource } from "../api.js";
import { makeCan, useEffectivePermissions } from "../iam.js";
import { PageTitle, StatusBadge } from "../components/ui.js";

interface Job {
  id: string;
  vmId: string | null;
  status: string;
  error: string | null;
  createdByUserId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface Step {
  id: string;
  step: string;
  state: string;
  error: string | null;
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
  const [live, setLive] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const watch = (id: string) => {
    setLive(id);
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
    <div>
      <PageTitle title="Provisioning Jobs" />
      {progress && <div className="bg-blue-950 border border-blue-800 text-blue-200 rounded p-3 mb-4 text-sm font-mono">{progress}</div>}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
            <th className="py-2">Job</th>
            <th className="py-2">Status</th>
            <th className="py-2">Created</th>
            <th className="py-2">Finished</th>
            <th className="py-2">Error</th>
            <th className="py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {(jobs?.jobs ?? []).map((j) => (
            <tr key={j.id} className="border-b border-slate-800/50 hover:bg-slate-900/50">
              <td className="py-2 font-mono text-xs">{j.id.slice(0, 8)}…</td>
              <td><StatusBadge status={j.status} /></td>
              <td className="text-xs text-slate-400">{new Date(j.createdAt).toLocaleString()}</td>
              <td className="text-xs text-slate-400">{j.finishedAt ? new Date(j.finishedAt).toLocaleString() : "—"}</td>
              <td className="text-xs text-red-300 max-w-xs truncate">{j.error ?? "—"}</td>
              <td>
                <div className="flex gap-2">
                  {!["READY", "FAILED", "CANCELLED"].includes(j.status) && (
                    <>
                      <button className="text-xs underline" onClick={() => watch(j.id)}>Watch</button>
                      {canCancel && (
                        <button className="text-xs text-amber-300 underline" onClick={() => void cancel(j.id)}>Cancel</button>
                      )}
                    </>
                  )}
                  {["FAILED", "CANCELLED"].includes(j.status) && (
                    <>
                      {canRetry && (
                        <button className="text-xs text-blue-300 underline" onClick={() => void retry(j.id)}>RETRY</button>
                      )}
                      {canRollback && (
                        <>
                          <button className="text-xs underline" onClick={() => void rollback(j.id, "keep")}>KEEP FOR DEBUGGING</button>
                          <button className="text-xs text-red-300 underline" onClick={() => void rollback(j.id, "delete")}>DELETE VM</button>
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
  );
}


