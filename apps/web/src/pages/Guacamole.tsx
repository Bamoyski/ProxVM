import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { MonitorUp, Search } from "lucide-react";
import { api, explainDenial } from "../api.js";
import { usePref } from "../prefs.js";
import { fmtDateTime } from "../lib/format.js";
import {
  PageHeader, StatusBadge, EmptyState, Btn, useToast, errText, TableSkeleton, Alert,
} from "../ui/index.js";

interface GuacConnection {
  id: string;
  vmId: string;
  vmName: string;
  vmid: number;
  node: string;
  protocol: string;
  hostname: string;
  port: number;
  username: string;
  status: string;
  guacConnectionName: string;
  lastVerifiedAt: string | null;
}

/** Every Guacamole connection ProxVM manages, across all VMs. */
export default function Guacamole() {
  const toast = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["guacamole-connections"],
    queryFn: () => api<{ connections: GuacConnection[] }>("/guacamole/connections"),
    refetchInterval: 15000,
  });
  const [search, setSearch] = usePref("guac-search", "");
  const [proto, setProto] = usePref("guac-proto", "all");

  const launch = async (vmId: string, protocol?: string) => {
    try {
      const res = await api<{ url: string; mode?: string; detail?: string }>(`/vms/${vmId}/guacamole/launch`, {
        method: "POST",
        body: protocol ? { protocol } : {},
      });
      if (res.mode === "login") {
        toast.warn("Direct session unavailable", res.detail ?? "Opening the Guacamole login page instead.");
      }
      window.open(res.url, "_blank", "noopener");
    } catch (err) {
      toast.err("Could not open console", explainDenial(err) ?? errText(err));
    }
  };

  const q = search.trim().toLowerCase();
  const rows = (data?.connections ?? []).filter((c) => {
    if (proto !== "all" && c.protocol !== proto) return false;
    if (!q) return true;
    return (
      c.vmName.toLowerCase().includes(q) ||
      c.protocol.toLowerCase().includes(q) ||
      c.username.toLowerCase().includes(q) ||
      c.guacConnectionName.toLowerCase().includes(q) ||
      String(c.vmid).includes(q)
    );
  });

  const protocols = Array.from(new Set((data?.connections ?? []).map((c) => c.protocol))).sort();

  return (
    <div className="pv-page">
      <PageHeader
        title="Consoles"
        description="Remote-access endpoints managed by ProxVM. Each opens an authenticated session without exposing guest ports directly."
      />

      <div className="pv-toolbar">
        <div className="pv-search">
          <Search size={13} className="pv-search-ico" aria-hidden="true" />
          <input
            className="pv-input"
            placeholder="Search VM, protocol, user…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search connections"
          />
        </div>
        <select
          className="pv-input pv-input-auto"
          style={{ height: 30 }}
          value={proto}
          onChange={(e) => setProto(e.target.value)}
          aria-label="Filter by protocol"
        >
          <option value="all">All protocols</option>
          {protocols.map((p) => (
            <option key={p} value={p}>{p.toUpperCase()}</option>
          ))}
        </select>
        <span className="pv-faint" style={{ fontSize: "0.78rem", marginLeft: "auto" }}>
          {rows.length} of {data?.connections.length ?? 0} connections
        </span>
      </div>

      {isLoading && !data ? (
        <div className="pv-table-wrap"><TableSkeleton rows={5} cols={7} /></div>
      ) : (
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>VM</th>
                <th>Protocol</th>
                <th className="pv-hide-sm">Endpoint</th>
                <th className="pv-hide-md">Username</th>
                <th className="pv-hide-md">Connection name</th>
                <th className="pv-hide-md">Last verified</th>
                <th style={{ width: 90 }}><span className="pv-sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td><StatusBadge status={c.status} /></td>
                  <td>
                    <Link to={`/vms/${c.vmId}`} style={{ fontWeight: 550 }}>{c.vmName}</Link>{" "}
                    <span className="pv-mono pv-faint">({c.vmid}@{c.node})</span>
                  </td>
                  <td className="pv-mono" style={{ textTransform: "uppercase" }}>{c.protocol}</td>
                  <td className="pv-mono pv-hide-sm">{c.hostname}:{c.port}</td>
                  <td className="pv-mono pv-hide-md">{c.username}</td>
                  <td className="pv-mono pv-hide-md" style={{ color: "var(--pv-text-2)" }}>{c.guacConnectionName}</td>
                  <td className="pv-faint pv-hide-md">{c.lastVerifiedAt ? fmtDateTime(c.lastVerifiedAt) : "never"}</td>
                  <td style={{ textAlign: "right" }}>
                    <Btn size="sm" kind="primary" onClick={() => void launch(c.vmId, c.protocol)}>
                      <MonitorUp size={12} aria-hidden="true" /> Open
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && data && !data.connections.length && (
        <EmptyState
          title="No Guacamole connections"
          body="They are created automatically when a VM is provisioned with at least one protocol."
          action={<Link to="/vms" style={{ fontSize: "0.85rem" }}>Go to virtual machines →</Link>}
        />
      )}
      {!isLoading && data && data.connections.length > 0 && rows.length === 0 && (
        <EmptyState
          title="No connections match the current filters"
          body="Try a different search term or protocol filter."
          action={
            <Btn size="sm" onClick={() => { setSearch(""); setProto("all"); }}>Clear filters</Btn>
          }
        />
      )}
    </div>
  );
}
