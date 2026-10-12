import { useQuery } from "@tanstack/react-query";
import { api, explainDenial } from "../api.js";
import { PageTitle, StatusBadge, Empty, Btn } from "../components/ui.js";

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

export default function Guacamole() {
  const { data } = useQuery({
    queryKey: ["guacamole-connections"],
    queryFn: () => api<{ connections: GuacConnection[] }>("/guacamole/connections"),
    refetchInterval: 15000,
  });

  const launch = async (vmId: string, protocol?: string) => {
    try {
      const res = await api<{ url: string }>(`/vms/${vmId}/guacamole/launch`, { method: "POST", body: protocol ? { protocol } : {} });
      window.open(res.url, "_blank", "noopener");
    } catch (err) {
      alert(explainDenial(err) ?? (err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <div className="pv-page">
      <PageTitle
        title="Guacamole connections"
        description="Remote-access endpoints managed by ProxVM. Each opens an authenticated session without exposing guest ports."
      />
      <div className="pv-table-wrap">
        <table className="pv-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>VM</th>
              <th>Protocol</th>
              <th>Endpoint</th>
              <th>Username</th>
              <th>Connection name</th>
              <th>Last verified</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(data?.connections ?? []).map((c) => (
              <tr key={c.id}>
                <td><StatusBadge status={c.status} /></td>
                <td>{c.vmName} <span className="pv-mono" style={{ color: "var(--pv-text-3)" }}>({c.vmid}@{c.node})</span></td>
                <td className="pv-mono" style={{ textTransform: "uppercase" }}>{c.protocol}</td>
                <td className="pv-mono">{c.hostname}:{c.port}</td>
                <td className="pv-mono">{c.username}</td>
                <td className="pv-mono" style={{ color: "var(--pv-text-2)" }}>{c.guacConnectionName}</td>
                <td style={{ color: "var(--pv-text-2)" }}>{c.lastVerifiedAt ? new Date(c.lastVerifiedAt).toLocaleString() : "never"}</td>
                <td>
                  <Btn size="sm" kind="primary" onClick={() => void launch(c.vmId, c.protocol)}>
                    Open
                  </Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data?.connections.length && (
        <Empty title="No Guacamole connections" body="They are created automatically when a VM is provisioned." />
      )}
    </div>
  );
}
