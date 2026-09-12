import { useQuery } from "@tanstack/react-query";
import { api, explainDenial } from "../api.js";
import { PageTitle, StatusBadge } from "../components/ui.js";

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
      window.open(res.url, "_blank");
    } catch (err) {
      alert(explainDenial(err) ?? (err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <div>
      <PageTitle title="Guacamole Connections" />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
              <th className="py-2">Status</th>
              <th className="py-2">VM</th>
              <th className="py-2">Protocol</th>
              <th className="py-2">Endpoint</th>
              <th className="py-2">Username</th>
              <th className="py-2">Connection name</th>
              <th className="py-2">Last verified</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.connections ?? []).map((c) => (
              <tr key={c.id} className="border-b border-slate-800/50 hover:bg-slate-900/50">
                <td className="py-2"><StatusBadge status={c.status} /></td>
                <td>{c.vmName} <span className="text-xs text-slate-500 font-mono">({c.vmid}@{c.node})</span></td>
                <td className="uppercase">{c.protocol}</td>
                <td className="font-mono text-xs">{c.hostname}:{c.port}</td>
                <td className="font-mono text-xs">{c.username}</td>
                <td className="font-mono text-xs text-slate-400">{c.guacConnectionName}</td>
                <td className="text-xs text-slate-500">{c.lastVerifiedAt ? new Date(c.lastVerifiedAt).toLocaleString() : "never"}</td>
                <td>
                  <button onClick={() => void launch(c.vmId, c.protocol)} className="px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500">
                    OPEN
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data?.connections.length && <div className="text-sm text-slate-500 py-4">No Guacamole connections. They are created automatically when a VM is provisioned.</div>}
      </div>
    </div>
  );
}