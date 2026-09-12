import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox, useConfirm } from "../components/ui.js";
import { OS_TYPES, PROVISIONING_METHODS, PROTOCOLS } from "@proxvm/shared";

export default function Templates() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const { data: templates } = useQuery({
    queryKey: ["templates"],
    queryFn: () => api<{ templates: Array<Record<string, unknown>> }>("/templates"),
  });
  const { data: proxmoxTemplates } = useQuery({
    queryKey: ["proxmox-templates"],
    queryFn: () => api<{ templates: Array<{ vmid: number; node: string; name: string }> }>("/proxmox/templates"),
  });
  const [selected, setSelected] = useState("");
  const [form, setForm] = useState({
    name: "",
    osType: "linux" as (typeof OS_TYPES)[number],
    provisioningMethod: "cloud-init" as (typeof PROVISIONING_METHODS)[number],
    cloudInitSupport: true,
    guestAgentRequired: true,
    defaultCpu: 2,
    defaultRamMb: 2048,
    defaultDiskGb: 20,
    supportedProtocols: ["ssh"] as string[],
  });
  const [error, setError] = useState<string | null>(null);
  const input = "w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm";
  const label = "block text-xs font-medium text-slate-400 mb-1";

  const sel = proxmoxTemplates?.templates.find((t) => `${t.node}/${t.vmid}` === selected);

  const register = async () => {
    if (!sel) return;
    try {
      await api("/templates", {
        method: "POST",
        body: {
          name: form.name || sel.name || `template-${sel.vmid}`,
          node: sel.node,
          proxmoxVmid: sel.vmid,
          osType: form.osType,
          provisioningMethod: form.provisioningMethod,
          cloudInitSupport: form.cloudInitSupport,
          guestAgentRequired: form.guestAgentRequired,
          defaultCpu: form.defaultCpu,
          defaultRamMb: form.defaultRamMb,
          defaultDiskGb: form.defaultDiskGb,
          supportedProtocols: form.supportedProtocols,
        },
      });
      setSelected("");
      void qc.invalidateQueries({ queryKey: ["templates"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <PageTitle title="Templates" />
      {dialog}
      {error && <ErrorBox error={error} />}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-3">Register a template from Proxmox</h2>
          <p className="text-xs text-slate-500 mb-3">Discovered from the live Proxmox cluster:</p>
          <select className={input} value={selected} onChange={(e) => { setSelected(e.target.value); const t = proxmoxTemplates?.templates.find((x) => `${x.node}/${x.vmid}` === e.target.value); if (t) setForm((f) => ({ ...f, name: t.name || f.name })); }}>
            <option value="">Select a Proxmox template…</option>
            {(proxmoxTemplates?.templates ?? []).map((t) => (
              <option key={`${t.node}/${t.vmid}`} value={`${t.node}/${t.vmid}`}>{t.name} (vmid {t.vmid}, node {t.node})</option>
            ))}
          </select>
          {sel && (
            <div className="mt-3 space-y-3">
              <div>
                <label className={label}>Display name</label>
                <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={label}>OS type</label>
                  <select className={input} value={form.osType} onChange={(e) => setForm({ ...form, osType: e.target.value as (typeof OS_TYPES)[number] })}>
                    {OS_TYPES.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div>
                  <label className={label}>Provisioning method</label>
                  <select className={input} value={form.provisioningMethod} onChange={(e) => setForm({ ...form, provisioningMethod: e.target.value as (typeof PROVISIONING_METHODS)[number] })}>
                    {PROVISIONING_METHODS.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.cloudInitSupport} onChange={(e) => setForm({ ...form, cloudInitSupport: e.target.checked })} />
                Cloud-init / Cloudbase-Init supported
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.guestAgentRequired} onChange={(e) => setForm({ ...form, guestAgentRequired: e.target.checked })} />
                QEMU guest agent required
              </label>
              <div className="grid grid-cols-3 gap-3">
                <div><label className={label}>CPU</label><input type="number" className={input} value={form.defaultCpu} onChange={(e) => setForm({ ...form, defaultCpu: Number(e.target.value) })} /></div>
                <div><label className={label}>RAM (MB)</label><input type="number" className={input} value={form.defaultRamMb} onChange={(e) => setForm({ ...form, defaultRamMb: Number(e.target.value) })} /></div>
                <div><label className={label}>Disk (GB)</label><input type="number" className={input} value={form.defaultDiskGb} onChange={(e) => setForm({ ...form, defaultDiskGb: Number(e.target.value) })} /></div>
              </div>
              <div>
                <label className={label}>Supported protocols</label>
                <div className="flex gap-3 text-sm">
                  {PROTOCOLS.map((p) => (
                    <label key={p} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={form.supportedProtocols.includes(p)}
                        onChange={(e) => setForm((f) => ({ ...f, supportedProtocols: e.target.checked ? [...f.supportedProtocols, p] : f.supportedProtocols.filter((x) => x !== p) }))}
                      />
                      {p.toUpperCase()}
                    </label>
                  ))}
                </div>
              </div>
              <button onClick={register} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm">Register template</button>
            </div>
          )}
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-3">Registered templates</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
                <th className="py-2">Name</th>
                <th className="py-2">Proxmox ID</th>
                <th className="py-2">Node</th>
                <th className="py-2">OS</th>
                <th className="py-2">Provisioning</th>
                <th className="py-2">Defaults</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(templates?.templates ?? []).map((t) => (
                <tr key={String(t.id)} className="border-b border-slate-800/50">
                  <td className="py-2">{String(t.name)}</td>
                  <td className="font-mono">{String(t.proxmoxVmid)}</td>
                  <td>{String(t.node)}</td>
                  <td>{String(t.osType)}</td>
                  <td className="text-xs">{String(t.provisioningMethod)}</td>
                  <td className="text-xs text-slate-400">{String(t.defaultCpu)}c / {String(t.defaultRamMb)}MB / {String(t.defaultDiskGb)}G</td>
                  <td>
                    <button
                      className="text-xs text-red-300 underline"
                      onClick={() =>
                        confirm(`Delete template ${String(t.name)}?`, `DELETE ${String(t.name)}`, async () => {
                          await api(`/templates/${String(t.id)}`, { method: "DELETE", body: { confirmText: `DELETE ${String(t.name)}` } });
                          void qc.invalidateQueries({ queryKey: ["templates"] });
                        })
                      }
                    >
                      DELETE
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!templates?.templates.length && <div className="text-sm text-slate-500 py-2">No templates registered yet.</div>}
        </div>
      </div>
    </div>
  );
}