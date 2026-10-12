import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox, Section, Empty, Btn, useConfirm } from "../components/ui.js";
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
    <div className="pv-page">
      <PageTitle title="Templates" description="Register Proxmox templates as provisioning sources." />
      {dialog}
      {error && <ErrorBox error={error} />}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-10">
        <Section title="Register from Proxmox" hint="Discovered from the live cluster">
          <div className="pv-field">
            <label className="pv-label">Proxmox template</label>
            <select className="pv-select" value={selected} onChange={(e) => { setSelected(e.target.value); const t = proxmoxTemplates?.templates.find((x) => `${x.node}/${x.vmid}` === e.target.value); if (t) setForm((f) => ({ ...f, name: t.name || f.name })); }}>
              <option value="">Select a Proxmox template…</option>
              {(proxmoxTemplates?.templates ?? []).map((t) => (
                <option key={`${t.node}/${t.vmid}`} value={`${t.node}/${t.vmid}`}>{t.name} (vmid {t.vmid}, node {t.node})</option>
              ))}
            </select>
          </div>
          {sel && (
            <div>
              <div className="pv-field">
                <label className="pv-label">Display name</label>
                <input className="pv-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="pv-field">
                  <label className="pv-label">OS type</label>
                  <select className="pv-select" value={form.osType} onChange={(e) => setForm({ ...form, osType: e.target.value as (typeof OS_TYPES)[number] })}>
                    {OS_TYPES.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className="pv-field">
                  <label className="pv-label">Provisioning method</label>
                  <select className="pv-select" value={form.provisioningMethod} onChange={(e) => setForm({ ...form, provisioningMethod: e.target.value as (typeof PROVISIONING_METHODS)[number] })}>
                    {PROVISIONING_METHODS.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              </div>
              <label className="pv-checkrow" style={{ marginBottom: 8 }}>
                <input type="checkbox" checked={form.cloudInitSupport} onChange={(e) => setForm({ ...form, cloudInitSupport: e.target.checked })} />
                Cloud-init / Cloudbase-Init supported
              </label>
              <label className="pv-checkrow" style={{ marginBottom: 12 }}>
                <input type="checkbox" checked={form.guestAgentRequired} onChange={(e) => setForm({ ...form, guestAgentRequired: e.target.checked })} />
                QEMU guest agent required
              </label>
              <div className="grid grid-cols-3 gap-3">
                <div className="pv-field"><label className="pv-label">CPU</label><input type="number" className="pv-input" value={form.defaultCpu} onChange={(e) => setForm({ ...form, defaultCpu: Number(e.target.value) })} /></div>
                <div className="pv-field"><label className="pv-label">RAM (MB)</label><input type="number" className="pv-input" value={form.defaultRamMb} onChange={(e) => setForm({ ...form, defaultRamMb: Number(e.target.value) })} /></div>
                <div className="pv-field"><label className="pv-label">Disk (GB)</label><input type="number" className="pv-input" value={form.defaultDiskGb} onChange={(e) => setForm({ ...form, defaultDiskGb: Number(e.target.value) })} /></div>
              </div>
              <div className="pv-field">
                <label className="pv-label">Supported protocols</label>
                <div style={{ display: "flex", gap: 16 }}>
                  {PROTOCOLS.map((p) => (
                    <label key={p} className="pv-checkrow">
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
              <Btn kind="primary" onClick={register}>Register template</Btn>
            </div>
          )}
        </Section>
        <Section title="Registered" hint={`${(templates?.templates ?? []).length} total`}>
          <div className="pv-table-wrap">
            <table className="pv-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Proxmox ID</th>
                  <th>Node</th>
                  <th>OS</th>
                  <th>Provisioning</th>
                  <th>Defaults</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(templates?.templates ?? []).map((t) => (
                  <tr key={String(t.id)}>
                    <td>{String(t.name)}</td>
                    <td className="pv-mono">{String(t.proxmoxVmid)}</td>
                    <td>{String(t.node)}</td>
                    <td>{String(t.osType)}</td>
                    <td style={{ color: "var(--pv-text-2)" }}>{String(t.provisioningMethod)}</td>
                    <td style={{ color: "var(--pv-text-2)" }}>{String(t.defaultCpu)}c / {String(t.defaultRamMb)}MB / {String(t.defaultDiskGb)}G</td>
                    <td>
                      <Btn
                        size="sm"
                        kind="link"
                        onClick={() =>
                          confirm(`Delete template ${String(t.name)}?`, `DELETE ${String(t.name)}`, async () => {
                            await api(`/templates/${String(t.id)}`, { method: "DELETE", body: { confirmText: `DELETE ${String(t.name)}` } });
                            void qc.invalidateQueries({ queryKey: ["templates"] });
                          })
                        }
                      >
                        Delete
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!templates?.templates.length && <Empty title="No templates registered yet" body="Register one from the Proxmox cluster to enable provisioning." />}
        </Section>
      </div>
    </div>
  );
}
