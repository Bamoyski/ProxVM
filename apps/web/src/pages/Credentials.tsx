import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, StatusBadge, copyText, masked } from "../components/ui.js";

interface CredEntry {
  vmId: string;
  vmName: string;
  vmid: number;
  node: string;
  username: string;
  status: string;
  createdAt: string;
  lastVerifiedAt: string | null;
  lastRotatedAt: string | null;
}

export default function Credentials() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["credentials"],
    queryFn: () => api<{ credentials: CredEntry[] }>("/credentials"),
    refetchInterval: 15000,
  });
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const reveal = async (entry: CredEntry) => {
    try {
      const res = await api<{ password: string }>(`/vms/${entry.vmId}/credentials/reveal`, { method: "POST" });
      setRevealed((r) => ({ ...r, [entry.vmId]: res.password }));
      setTimeout(() => setRevealed((r) => ({ ...r, [entry.vmId]: "" })), 30000);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const copy = async (entry: CredEntry) => {
    try {
      const res = await api<{ password: string }>(`/vms/${entry.vmId}/credentials/copy`, { method: "POST" });
      const ok = await copyText(res.password);
      if (!ok) setRevealed((r) => ({ ...r, [entry.vmId]: res.password }));
      setRevealed((r) => ({ ...r, [entry.vmId]: res.password }));
      setTimeout(() => setRevealed((r) => ({ ...r, [entry.vmId]: "" })), 30000);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const rotate = async (entry: CredEntry) => {
    if (!window.confirm(`Rotate the credential for ${entry.vmName}? The new password is applied to the guest and Guacamole.`)) return;
    try {
      const res = await api<{ success: boolean; mechanism: string; verified: boolean }>(`/vms/${entry.vmId}/credentials/rotate`, { method: "POST", body: {} });
      alert(`Rotated via ${res.mechanism} (verified: ${res.verified})`);
      void qc.invalidateQueries({ queryKey: ["credentials"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const btn = "px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700";

  return (
    <div>
      <PageTitle title="Credential Vault" />
      <p className="text-xs text-slate-500 mb-4">
        Passwords are stored with authenticated encryption (AES-256-GCM). Revealing or copying is audited. Passwords auto-hide after 30 seconds.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
              <th className="py-2">VM</th>
              <th className="py-2">Username</th>
              <th className="py-2">Credential status</th>
              <th className="py-2">Created</th>
              <th className="py-2">Last verified</th>
              <th className="py-2">Last rotated</th>
              <th className="py-2">Password</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.credentials ?? []).map((c) => (
              <tr key={c.vmId} className="border-b border-slate-800/50 hover:bg-slate-900/50">
                <td className="py-2">
                  <Link to={`/vms/${c.vmId}`} className="text-blue-400 hover:underline">{c.vmName}</Link>
                  <span className="text-xs text-slate-500 ml-1 font-mono">({c.vmid}@{c.node})</span>
                </td>
                <td className="font-mono text-xs">{c.username}</td>
                <td><StatusBadge status={c.status} /></td>
                <td className="text-xs text-slate-400">{new Date(c.createdAt).toLocaleDateString()}</td>
                <td className="text-xs text-slate-400">{c.lastVerifiedAt ? new Date(c.lastVerifiedAt).toLocaleString() : "never"}</td>
                <td className="text-xs text-slate-400">{c.lastRotatedAt ? new Date(c.lastRotatedAt).toLocaleString() : "never"}</td>
                <td className="font-mono">{revealed[c.vmId] || masked()}</td>
                <td>
                  <div className="flex gap-1">
                    <button className={btn} onClick={() => void reveal(c)}>REVEAL</button>
                    <button className={btn} onClick={() => void copy(c)}>COPY</button>
                    <button className={`${btn} text-amber-300`} onClick={() => void rotate(c)}>ROTATE</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data?.credentials.length && <div className="text-sm text-slate-500 py-4">No stored credentials yet.</div>}
      </div>
    </div>
  );
}