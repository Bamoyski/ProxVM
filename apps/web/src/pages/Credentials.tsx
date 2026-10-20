import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { fmtDate, fmtDateTime, copyToClipboard } from "../lib/format.js";
import {
  PageHeader, StatusBadge, EmptyState, Btn, TableSkeleton, useConfirm, useToast, errText, Tooltip,
} from "../ui/index.js";

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

const MASK = "••••••••••••••••••";

/** Encrypted credential inventory: reveal / copy / rotate, all audited. */
export default function Credentials() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery({
    queryKey: ["credentials"],
    queryFn: () => api<{ credentials: CredEntry[] }>("/credentials"),
    refetchInterval: 15000,
  });
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const reveal = async (entry: CredEntry) => {
    setBusy(`reveal-${entry.vmId}`);
    try {
      const res = await api<{ password: string; autoHideSeconds?: number }>(`/vms/${entry.vmId}/credentials/reveal`, { method: "POST" });
      setRevealed((r) => ({ ...r, [entry.vmId]: res.password }));
      setTimeout(() => setRevealed((r) => ({ ...r, [entry.vmId]: "" })), (res.autoHideSeconds ?? 30) * 1000);
    } catch (err) {
      toast.err("Reveal failed", errText(err));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (entry: CredEntry) => {
    setBusy(`copy-${entry.vmId}`);
    try {
      const res = await api<{ password: string }>(`/vms/${entry.vmId}/credentials/copy`, { method: "POST" });
      const ok = await copyToClipboard(res.password);
      setRevealed((r) => ({ ...r, [entry.vmId]: res.password }));
      setTimeout(() => setRevealed((r) => ({ ...r, [entry.vmId]: "" })), 30000);
      if (ok) toast.ok("Copied to clipboard", `${entry.vmName} — also shown below for 30 seconds.`);
      else toast.warn("Clipboard unavailable", `${entry.vmName} — the password is shown below, copy it manually.`);
    } catch (err) {
      toast.err("Copy failed", errText(err));
    } finally {
      setBusy(null);
    }
  };

  const rotate = async (entry: CredEntry) => {
    const ok = await confirm({
      title: `Rotate the credential for ${entry.vmName}?`,
      confirmLabel: "Rotate password",
      body: "The new password is applied to the guest and Guacamole, then re-verified. The old password stops working immediately.",
    });
    if (!ok) return;
    setBusy(`rotate-${entry.vmId}`);
    try {
      const res = await api<{ success: boolean; mechanism: string; verified: boolean; details?: string }>(
        `/vms/${entry.vmId}/credentials/rotate`,
        { method: "POST", body: {} },
      );
      if (res.success) toast.ok("Rotated", `Mechanism: ${res.mechanism} · verified: ${res.verified}${res.details ? ` — ${res.details}` : ""}`);
      else toast.warn("Rotation finished with issues", res.details ?? `Mechanism: ${res.mechanism}`);
      void qc.invalidateQueries({ queryKey: ["credentials"] });
      void qc.invalidateQueries({ queryKey: ["vm", entry.vmId] });
    } catch (err) {
      toast.err("Rotation failed", errText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pv-page">
      <PageHeader
        title="Credential vault"
        description="Passwords are stored with authenticated encryption (AES-256-GCM). Revealing or copying is audited. Passwords auto-hide after 30 seconds."
      />
      <div className="pv-table-wrap">
        <table className="pv-table">
          <thead>
            <tr>
              <th>VM</th>
              <th className="pv-hide-sm">Username</th>
              <th>Status</th>
              <th className="pv-hide-md">Created</th>
              <th className="pv-hide-md">Last verified</th>
              <th className="pv-hide-md">Last rotated</th>
              <th>Password</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.credentials ?? []).map((c) => (
              <tr key={c.vmId}>
                <td>
                  <Link to={`/vms/${c.vmId}`} style={{ fontWeight: 550 }}>{c.vmName}</Link>
                  <span className="pv-mono pv-faint" style={{ marginLeft: 6 }}>({c.vmid}@{c.node})</span>
                </td>
                <td className="pv-mono pv-hide-sm">{c.username}</td>
                <td><StatusBadge status={c.status} /></td>
                <td className="pv-faint pv-hide-md">{fmtDate(c.createdAt)}</td>
                <td className="pv-faint pv-hide-md">{c.lastVerifiedAt ? fmtDateTime(c.lastVerifiedAt) : "never"}</td>
                <td className="pv-faint pv-hide-md">{c.lastRotatedAt ? fmtDateTime(c.lastRotatedAt) : "never"}</td>
                <td className="pv-mono" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {revealed[c.vmId] || (
                    <Tooltip content="Hidden until you reveal or copy it (both are audited)">
                      <span>{MASK}</span>
                    </Tooltip>
                  )}
                </td>
                <td>
                  <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                    <Btn size="sm" loading={busy === `reveal-${c.vmId}`} onClick={() => void reveal(c)}>Reveal</Btn>
                    <Btn size="sm" loading={busy === `copy-${c.vmId}`} onClick={() => void copy(c)}>Copy</Btn>
                    <Btn size="sm" kind="link" loading={busy === `rotate-${c.vmId}`} onClick={() => void rotate(c)}>Rotate</Btn>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isLoading && !data && <TableSkeleton rows={4} cols={6} />}
      {!isLoading && !data?.credentials.length && (
        <EmptyState
          title="No stored credentials yet"
          body="Provisioning a VM creates its guest credential automatically."
        />
      )}
    </div>
  );
}
