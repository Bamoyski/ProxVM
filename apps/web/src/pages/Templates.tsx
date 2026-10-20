import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { OS_TYPES, PROVISIONING_METHODS, PROTOCOLS } from "@proxvm/shared";
import {
  PageHeader, Section, EmptyState, Btn, Field, Input, Select, Checkbox, useConfirm, useToast, errText,
} from "../ui/index.js";

export default function Templates() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const { data: templates } = useQuery({
    queryKey: ["templates"],
    queryFn: () => api<{ templates: Array<Record<string, unknown>> }>("/templates"),
  });
  const { data: proxmoxTemplates } = useQuery({
    queryKey: ["proxmox-templates"],
    queryFn: () => api<{ templates: Array<{ vmid: number; node: string; name: string }> }>("/proxmox/templates"),
  });
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
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

  const sel = proxmoxTemplates?.templates.find((t) => `${t.node}/${t.vmid}` === selected);

  const register = async () => {
    if (!sel || busy) return;
    setBusy(true);
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
      toast.ok("Template registered", "It now appears in the provisioning wizard.");
      setSelected("");
      void qc.invalidateQueries({ queryKey: ["templates"] });
    } catch (err) {
      toast.err("Registration failed", errText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string, id: string) => {
    const ok = await confirm({
      title: `Delete template ${name}?`,
      danger: true,
      requireText: `DELETE ${name}`,
      confirmLabel: "Delete template",
      body: "Provisioning from this template stops working. VMs already created from it are unaffected.",
    });
    if (!ok) return;
    try {
      await api(`/templates/${id}`, { method: "DELETE", body: { confirmText: `DELETE ${name}` } });
      toast.ok("Template deleted");
      void qc.invalidateQueries({ queryKey: ["templates"] });
    } catch (err) {
      toast.err("Delete failed", errText(err));
    }
  };

  return (
    <div className="pv-page">
      <PageHeader title="Templates" description="Register Proxmox templates as provisioning sources." />
      <div className="pv-grid-2">
        <Section title="Register from Proxmox" hint="Discovered from the live cluster">
          <Field label="Proxmox template" required>
            {({ id }) => (
              <Select
                id={id}
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  const t = proxmoxTemplates?.templates.find((x) => `${x.node}/${x.vmid}` === e.target.value);
                  if (t) setForm((f) => ({ ...f, name: t.name || f.name }));
                }}
              >
                <option value="">Select a Proxmox template…</option>
                {(proxmoxTemplates?.templates ?? []).map((t) => (
                  <option key={`${t.node}/${t.vmid}`} value={`${t.node}/${t.vmid}`}>
                    {t.name} (vmid {t.vmid}, node {t.node})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {sel && (
            <div>
              <Field label="Display name" hint="Shown in the provisioning wizard.">
                {({ id }) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
              </Field>
              <div className="pv-grid-2">
                <Field label="OS type">
                  {({ id }) => (
                    <Select id={id} value={form.osType} onChange={(e) => setForm({ ...form, osType: e.target.value as (typeof OS_TYPES)[number] })}>
                      {OS_TYPES.map((o) => <option key={o} value={o}>{o}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="Provisioning method">
                  {({ id }) => (
                    <Select
                      id={id}
                      value={form.provisioningMethod}
                      onChange={(e) => setForm({ ...form, provisioningMethod: e.target.value as (typeof PROVISIONING_METHODS)[number] })}
                    >
                      {PROVISIONING_METHODS.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              <Checkbox
                label="Cloud-init / Cloudbase-Init supported"
                checked={form.cloudInitSupport}
                onChange={(e) => setForm({ ...form, cloudInitSupport: e.target.checked })}
              />
              <Checkbox
                label="QEMU guest agent required"
                checked={form.guestAgentRequired}
                onChange={(e) => setForm({ ...form, guestAgentRequired: e.target.checked })}
              />
              <div className="pv-grid-3">
                <Field label="CPU">{({ id }) => <Input id={id} type="number" min={1} value={form.defaultCpu} onChange={(e) => setForm({ ...form, defaultCpu: Number(e.target.value) })} />}</Field>
                <Field label="RAM (MB)">{({ id }) => <Input id={id} type="number" min={256} step={256} value={form.defaultRamMb} onChange={(e) => setForm({ ...form, defaultRamMb: Number(e.target.value) })} />}</Field>
                <Field label="Disk (GB)">{({ id }) => <Input id={id} type="number" min={1} value={form.defaultDiskGb} onChange={(e) => setForm({ ...form, defaultDiskGb: Number(e.target.value) })} />}</Field>
              </div>
              <div className="pv-field">
                <span className="pv-label">Supported protocols</span>
                <div className="pv-inline">
                  {PROTOCOLS.map((p) => (
                    <Checkbox
                      key={p}
                      label={p.toUpperCase()}
                      checked={form.supportedProtocols.includes(p)}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          supportedProtocols: e.target.checked
                            ? [...f.supportedProtocols, p]
                            : f.supportedProtocols.filter((x) => x !== p),
                        }))
                      }
                    />
                  ))}
                </div>
              </div>
              <Btn kind="primary" loading={busy} onClick={() => void register()} disabled={!form.supportedProtocols.length}>
                Register template
              </Btn>
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
                  <th className="pv-hide-sm">Node</th>
                  <th>OS</th>
                  <th className="pv-hide-md">Defaults</th>
                  <th style={{ width: 70 }}><span className="pv-sr-only">Delete</span></th>
                </tr>
              </thead>
              <tbody>
                {(templates?.templates ?? []).map((t) => (
                  <tr key={String(t.id)}>
                    <td>{String(t.name)}</td>
                    <td className="pv-mono">{String(t.proxmoxVmid)}</td>
                    <td className="pv-hide-sm">{String(t.node)}</td>
                    <td>{String(t.osType)}</td>
                    <td className="pv-faint pv-hide-md">{String(t.defaultCpu)}c / {String(t.defaultRamMb)}MB / {String(t.defaultDiskGb)}G</td>
                    <td style={{ textAlign: "right" }}>
                      <Btn size="sm" kind="link" onClick={() => void remove(String(t.name), String(t.id))}>
                        Delete
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!templates?.templates.length && (
            <EmptyState
              title="No templates registered yet"
              body="Register one from the Proxmox cluster to enable provisioning."
            />
          )}
        </Section>
      </div>
    </div>
  );
}
