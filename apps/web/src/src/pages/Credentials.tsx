import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, StatusBadge, Empty, Btn, copyText, masked } from "../components/ui.js";

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

  return (
    <div className="pv-page">
      <PageTitle
        title="Credential vault"
        description="Passwords are stored with authenticated encryption (AES-256-GCM). Revealing or copying is audited. Passwords auto-hide after 30 seconds."
      />
      <div className="pv-table-wrap">
        <table className="pv-table">
          <thead>
            <tr>
              <th>VM</th>
              <th>Username</th>
              <th>Status</th>
              <th>Created</th>
              <th>Last verified</th>
              <th>Last rotated</th>
              <th>Password</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.credentials ?? []).map((c) => (
              <tr key={c.vmId}>
                <td>
                  <Link to={`/vms/${c.vmId}`}>{c.vmName}</Link>
                  <span className="pv-mono" style={{ marginLeft: 6, color: "var(--pv-text-3)" }}>({c.vmid}@{c.node})</span>
                </td>
                <td className="pv-mono">{c.username}</td>
                <td><StatusBadge status={c.status} /></td>
                <td style={{ color: "var(--pv-text-2)" }}>{new Date(c.createdAt).toLocaleDateString()}</td>
                <td style={{ color: "var(--pv-text-2)" }}>{c.lastVerifiedAt ? new Date(c.lastVerifiedAt).toLocaleString() : "never"}</td>
                <td style={{ color: "var(--pv-text-2)" }}>{c.lastRotatedAt ? new Date(c.lastRotatedAt).toLocaleString() : "never"}</td>
                <td className="pv-mono">{revealed[c.vmId] || masked()}</td>
                <td>
                  <div style={{ display: "flex", gap: 4 }}>
                    <Btn size="sm" onClick={() => void reveal(c)}>Reveal</Btn>
                    <Btn size="sm" onClick={() => void copy(c)}>Copy</Btn>
                    <Btn size="sm" kind="link" onClick={() => void rotate(c)}>Rotate</Btn>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data?.credentials.length && (
        <Empty title="No stored credentials yet" body="Provisioning a VM creates its guest credential automatically." />
      )}
    </div>
  );
}
