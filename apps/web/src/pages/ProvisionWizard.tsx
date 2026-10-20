import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleDashed, X } from "lucide-react";
import { api, jobEventSource } from "../api.js";
import { savePref } from "../prefs.js";
import { buildBasicPayload, buildAdvancedPayload } from "../lib/provision.js";
import { useToast, errText } from "../ui/index.js";
import { Btn, Dialog, Field, Input, Select, Checkbox, Alert, Spinner, StatusBadge } from "../ui/index.js";

interface TemplateOption {
  id: string;
  name: string;
  node: string;
  proxmoxVmid: number;
  osType: string;
  defaultCpu: number;
  defaultRamMb: number;
  defaultDiskGb: number;
  supportedProtocols?: string[];
}

interface ProvisionDefaults {
  node: string | null;
  storage: string | null;
  bridge: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  guestUser: string;
  protocols: string[];
  verified: boolean;
  warnings: string[];
}

interface AssignUser {
  id: string;
  username: string;
  roles: string[];
}

const ADVANCED_STEPS = ["Template", "Resources", "Network", "Access", "Review"] as const;

/**
 * VM provisioning wizard. Basic = one compact form; Advanced = a five-step
 * flow ending in review. Both submit byte-identical payload shapes to the
 * legacy dialog (server resolves anything omitted). Submission is job-based:
 * 202 → SSE progress → terminal state, shown honestly.
 */
export default function ProvisionWizard({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<"basic" | "advanced">("basic");
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobState, setJobState] = useState<{ status: string | null; step: string | null; message: string | null }>({
    status: null,
    step: null,
    message: null,
  });
  const [jobError, setJobError] = useState<string | null>(null);

  const { data: templates } = useQuery({
    queryKey: ["templates"],
    queryFn: () => api<{ templates: TemplateOption[] }>("/templates"),
    staleTime: 60000,
  });

  const [basic, setBasic] = useState({
    name: "",
    templateId: "",
    cpu: 2,
    ramMb: 2048,
    diskGb: 20,
    bridge: "",
    protocols: [] as string[],
  });
  const [form, setForm] = useState({
    name: "",
    templateId: "",
    node: "",
    vmid: "",
    cpu: 2,
    ramMb: 2048,
    diskGb: 20,
    storage: "",
    bridge: "",
    vlan: "",
    mode: "dhcp" as "dhcp" | "static",
    ip: "",
    cidr: "24",
    gateway: "",
    dns: "",
    guestUser: "deploy",
    password: "",
    linkedClone: true,
    protocols: ["ssh"] as string[],
  });
  const [assignIds, setAssignIds] = useState<string[]>([]);

  const active = mode === "basic" ? basic : form;
  const templateId = active.templateId;
  const tmpl = templates?.templates.find((t) => t.id === templateId);
  const supportedProtocols = tmpl?.supportedProtocols?.length
    ? tmpl.supportedProtocols
    : [tmpl?.osType === "windows" ? "rdp" : "ssh"];

  // Remember last-used infrastructure choices (never name/password/address).
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    if (prefsLoaded) return;
    setPrefsLoaded(true);
    try {
      const raw = window.localStorage.getItem("proxvm-pref:vms-provision");
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<typeof form>;
      setForm((f) => ({
        ...f,
        node: typeof saved.node === "string" ? saved.node : f.node,
        storage: typeof saved.storage === "string" ? saved.storage : f.storage,
        bridge: typeof saved.bridge === "string" ? saved.bridge : f.bridge,
        cpu: typeof saved.cpu === "number" ? saved.cpu : f.cpu,
        ramMb: typeof saved.ramMb === "number" ? saved.ramMb : f.ramMb,
        diskGb: typeof saved.diskGb === "number" ? saved.diskGb : f.diskGb,
      }));
    } catch {
      // corrupted prefs: start fresh
    }
  }, [prefsLoaded]);
  useEffect(() => {
    savePref("vms-provision", {
      node: form.node,
      storage: form.storage,
      bridge: form.bridge,
      cpu: form.cpu,
      ramMb: form.ramMb,
      diskGb: form.diskGb,
    });
  }, [form.node, form.storage, form.bridge, form.cpu, form.ramMb, form.diskGb]);

  const { data: nodes } = useQuery({
    queryKey: ["proxmox-nodes"],
    queryFn: () => api<{ nodes: Array<{ node: string; status: string }> }>("/proxmox/nodes"),
  });
  const selNode = form.node || nodes?.nodes[0]?.node || "";
  const { data: storage } = useQuery({
    queryKey: ["proxmox-storage", selNode],
    queryFn: () =>
      api<{ storage: Array<{ storage: string; node: string; content: string; type: string }> }>(
        `/proxmox/storage?node=${encodeURIComponent(selNode)}`,
      ),
    enabled: !!selNode,
  });
  const { data: networks } = useQuery({
    queryKey: ["proxmox-networks", selNode],
    queryFn: () =>
      api<{ networks: Array<{ iface: string; type: string; active: number }> }>(
        `/proxmox/networks?node=${encodeURIComponent(selNode)}`,
      ),
    enabled: !!selNode,
  });
  // Fresh generated password per wizard open; never persisted.
  const { data: generated } = useQuery({
    queryKey: ["genpw", "provision-wizard"],
    queryFn: () => api<{ password: string }>("/credentials/generate", { method: "POST" }),
    staleTime: 0,
    gcTime: 0,
  });
  const { data: defaults } = useQuery({
    queryKey: ["provision-defaults", templateId],
    queryFn: () =>
      api<ProvisionDefaults>(`/provisioning/defaults?templateId=${encodeURIComponent(templateId)}`),
    enabled: !!templateId,
  });
  const { data: usersData } = useQuery({
    queryKey: ["users"],
    queryFn: () => api<{ users: AssignUser[] }>("/users"),
    retry: false,
  });
  const grantableUsers = (usersData?.users ?? []).filter(
    (u) => !u.roles.includes("ADMIN") && !u.roles.includes("OPERATOR"),
  );

  const applyTemplate = (id: string) => {
    const t = templates?.templates.find((x) => x.id === id);
    const supported = t?.supportedProtocols?.length ? t.supportedProtocols : [t?.osType === "windows" ? "rdp" : "ssh"];
    setForm((f) => ({
      ...f,
      templateId: id,
      node: t?.node ?? f.node,
      cpu: t?.defaultCpu ?? 2,
      ramMb: t?.defaultRamMb ?? 2048,
      diskGb: t?.defaultDiskGb ?? 20,
      protocols: supported,
    }));
    setBasic((b) => ({
      ...b,
      templateId: id,
      cpu: t?.defaultCpu ?? 2,
      ramMb: t?.defaultRamMb ?? 2048,
      diskGb: t?.defaultDiskGb ?? 20,
      protocols: supported,
    }));
  };

  const toggleAssign = (userId: string) =>
    setAssignIds((prev) => (prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]));

  const toggleProtocol = (list: string[], p: string, set: (v: string[]) => void) =>
    set(list.includes(p) ? list.filter((x) => x !== p) : [...list, p]);

  /* ---------------------------- validation ---------------------------- */

  const basicValid =
    basic.name.trim() !== "" &&
    !!basic.templateId &&
    basic.cpu >= 1 && basic.cpu <= 512 &&
    basic.ramMb >= 256 &&
    basic.diskGb >= 1 &&
    basic.protocols.length > 0 &&
    !!generated;
  const advancedValid = {
    0: form.name.trim() !== "" && !!form.templateId,
    1: form.cpu >= 1 && form.ramMb >= 256 && form.diskGb >= 1,
    2: !!form.storage && !!form.bridge &&
      (form.mode === "dhcp" || (form.ip.trim() !== "" && form.gateway.trim() !== "")),
    3: form.protocols.length > 0 && form.guestUser.trim() !== "" && !!generated,
    4: true,
  } as Record<number, boolean>;

  /* ----------------------------- submission ---------------------------- */

  const startJobWatch = (id: string) => {
    jobEventSource(
      id,
      (data) => {
        const d = data as { status?: string; step?: string | null; message?: string };
        setJobState({ status: d.status ?? null, step: d.step ?? null, message: d.message ?? null });
        if (d.status === "FAILED") setJobError(d.message ?? "Provisioning failed.");
      },
      () => {
        void qc.invalidateQueries({ queryKey: ["vms"] });
        void qc.invalidateQueries({ queryKey: ["jobs"] });
      },
      (err) => {
        // Stream died (proxy timeout etc.): the job continues server-side;
        // say so instead of pretending it finished.
        setJobState((s) => ({
          ...s,
          message: `Live progress unavailable (${err.message}) — the job keeps running; the VM appears in the list when done.`,
        }));
        void qc.invalidateQueries({ queryKey: ["vms"] });
        void qc.invalidateQueries({ queryKey: ["jobs"] });
      },
    );
  };

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      let res: { jobId: string };
      if (mode === "basic") {
        res = await api<{ jobId: string }>("/vms/provision", {
          method: "POST",
          body: buildBasicPayload(basic, {
            password: generated?.password,
            assignToUserIds: assignIds,
          }),
        });
      } else {
        const t = templates?.templates.find((x) => x.id === form.templateId);
        res = await api<{ jobId: string }>("/vms/provision", {
          method: "POST",
          body: buildAdvancedPayload(form, {
            templateNode: t?.node,
            templateOsType: t?.osType,
            password: generated?.password,
            assignToUserIds: assignIds,
          }),
        });
      }
      setJobId(res.jobId);
      setJobState({ status: "QUEUED", step: null, message: "Queued — waiting for a worker…" });
      startJobWatch(res.jobId);
    } catch (err) {
      toast.err("Provisioning request failed", errText(err));
    } finally {
      setSubmitting(false);
    }
  };

  /* ------------------------------- render ------------------------------ */

  if (!templates) {
    return (
      <Dialog title="Provision virtual machine" onClose={onClose}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "12px 0" }}>
          <Spinner /> Loading templates…
        </div>
      </Dialog>
    );
  }

  if (!templates.templates.length) {
    return (
      <Dialog title="Provision virtual machine" onClose={onClose}>
        <Alert kind="warn" title="No templates registered">
          Register a Proxmox template first on the{" "}
          <Link to="/vms?tab=templates" onClick={onClose}>Templates</Link> tab, then provision from it.
        </Alert>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn onClick={onClose}>Close</Btn>
        </div>
      </Dialog>
    );
  }

  /* Live-progress phase (after submit): job status is shown honestly. */
  if (jobId) {
    const done = jobState.status === "READY";
    const failed = jobState.status === "FAILED" || jobState.status === "CANCELLED";
    return (
      <Dialog
        title={done ? "VM provisioning complete" : failed ? "VM provisioning failed" : "Provisioning in progress"}
        onClose={onClose}
        footer={
          done ? (
            <>
              <Btn onClick={onClose}>Close</Btn>
              <Btn kind="primary" onClick={onClose}>
                <Link to="/vms" onClick={onClose} style={{ color: "inherit" }}>Back to VMs</Link>
              </Btn>
            </>
          ) : failed ? (
            <Btn onClick={onClose}>Close</Btn>
          ) : (
            <Btn onClick={onClose}>Run in background</Btn>
          )
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0 8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {done ? (
              <Check size={16} style={{ color: "var(--pv-ok)" }} aria-hidden="true" />
            ) : failed ? (
              <X size={16} style={{ color: "var(--pv-err)" }} aria-hidden="true" />
            ) : (
              <CircleDashed size={16} style={{ color: "var(--pv-accent)" }} aria-hidden="true" />
            )}
            <StatusBadge status={jobState.status ?? "PENDING"} animate={!done && !failed} />
            <span className="pv-faint" style={{ fontSize: "0.78rem" }}>job {jobId.slice(0, 8)}</span>
          </div>
          {jobState.step && <div className="pv-mono" style={{ fontSize: "0.78rem", color: "var(--pv-text-2)" }}>step: {jobState.step}</div>}
          {jobState.message && <div style={{ fontSize: "0.83rem", color: "var(--pv-text-2)" }}>{jobState.message}</div>}
          {done && (
            <Alert kind="ok" title="Ready">
              The VM is being added to the fleet — it shows up in the VM list momentarily. Its
              Guacamole connection and credentials were created automatically.
            </Alert>
          )}
          {(failed || jobError) && (
            <Alert kind="err" title="Provisioning did not complete">
              {jobError ?? "The provisioning job failed."} Open Jobs on the dashboard to inspect the
              steps, retry, or roll back partial resources.
            </Alert>
          )}
        </div>
      </Dialog>
    );
  }

  const templatePicker = (
    <Field label="Template" required hint={defaults ? `Defaults from template · node ${defaults.node ?? "…"} · storage ${defaults.storage ?? "…"}${defaults.verified ? "" : " (unverified — Proxmox unreachable)"}` : undefined}>
      {({ id, describedBy }) => (
        <Select
          id={id}
          aria-describedby={describedBy}
          value={active.templateId}
          onChange={(e) => applyTemplate(e.target.value)}
        >
          <option value="">Select template…</option>
          {templates.templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.osType}, {t.node}/{t.proxmoxVmid})
            </option>
          ))}
        </Select>
      )}
    </Field>
  );

  const warnings =
    defaults?.warnings?.length ? (
      <Alert kind="warn" title="Template defaults need attention">
        {defaults.warnings.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </Alert>
    ) : null;

  const assignPicker =
    grantableUsers.length > 0 ? (
      <div className="pv-field">
        <span className="pv-label">Grant access to (optional)</span>
        <div style={{ maxHeight: 120, overflowY: "auto", border: "1px solid var(--pv-border-soft)", borderRadius: 6, padding: 8, background: "var(--pv-inset)" }}>
          {grantableUsers.map((u) => (
            <Checkbox
              key={u.id}
              label={u.username}
              checked={assignIds.includes(u.id)}
              onChange={() => toggleAssign(u.id)}
              style={{ padding: "3px 0" }}
            />
          ))}
        </div>
        <div className="pv-hint">Selected users receive this VM and its Guacamole connections.</div>
      </div>
    ) : null;

  const passwordBlock = (
    <div className="pv-field">
      <span className="pv-label">Guest password (generated, encrypted at rest)</span>
      <code
        className="pv-mono"
        style={{
          display: "block",
          background: "var(--pv-inset)",
          border: "1px solid var(--pv-border-soft)",
          borderRadius: 6,
          padding: "8px 10px",
          userSelect: "all",
          wordBreak: "break-all",
        }}
      >
        {generated?.password ?? "…"}
      </code>
      <div className="pv-hint">Copy it now — ProxVM stores it encrypted and reveals it from Credentials later.</div>
    </div>
  );

  const basicBody = (
    <>
      {templatePicker}
      {warnings}
      <Field label="Name" required>
        {({ id }) => (
          <Input id={id} placeholder="Debian Lab" value={basic.name} onChange={(e) => setBasic({ ...basic, name: e.target.value })} />
        )}
      </Field>
      <div className="pv-field">
        <span className="pv-label">Resources</span>
        <div className="pv-grid-3">
          <Stepper label="CPU" value={basic.cpu} unit={basic.cpu === 1 ? "core" : "cores"} min={1} max={32} step={1} onChange={(v) => setBasic({ ...basic, cpu: v })} />
          <Stepper label="Memory" value={Math.round(basic.ramMb / 1024)} unit="GB" min={1} max={128} step={1} onChange={(v) => setBasic({ ...basic, ramMb: v * 1024 })} />
          <Stepper label="Disk" value={basic.diskGb} unit="GB" min={8} max={1024} step={4} onChange={(v) => setBasic({ ...basic, diskGb: v })} />
        </div>
        <div className="pv-hint">
          Node {defaults?.node ?? "…"} · Storage {defaults?.storage ?? "…"}
        </div>
      </div>
      <Field label="Network bridge" hint="DHCP addressing is used in basic mode.">
        {({ id }) => (
          <Select id={id} value={basic.bridge || defaults?.bridge || "vmbr0"} onChange={(e) => setBasic({ ...basic, bridge: e.target.value })}>
            {(networks?.networks?.length ? networks.networks.map((n) => n.iface) : [basic.bridge || defaults?.bridge || "vmbr0"]).map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </Select>
        )}
      </Field>
      <div className="pv-field">
        <span className="pv-label">Remote access protocols</span>
        {!basic.templateId ? (
          <div className="pv-hint">Select a template to choose protocols.</div>
        ) : (
          <div className="pv-inline">
            {supportedProtocols.map((p) => (
              <Checkbox
                key={p}
                label={p.toUpperCase()}
                checked={basic.protocols.includes(p)}
                onChange={(e) => toggleProtocol(basic.protocols, p, (v) => setBasic({ ...basic, protocols: v }))}
              />
            ))}
          </div>
        )}
      </div>
      {assignPicker}
      {passwordBlock}
    </>
  );

  const stepBodies: React.ReactNode[] = [
    // 0: template & identity
    <>
      {templatePicker}
      {warnings}
      <Field label="VM name" required hint="Shown across ProxVM and used for the Guacamole connection.">
        {({ id }) => (
          <Input id={id} placeholder="Debian Lab" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        )}
      </Field>
      <Field label="VM ID" hint="Leave blank to auto-assign the next free ID.">
        {({ id }) => (
          <Input id={id} inputMode="numeric" placeholder="auto" value={form.vmid} onChange={(e) => setForm({ ...form, vmid: e.target.value.replace(/[^0-9]/g, "") })} />
        )}
      </Field>
    </>,
    // 1: resources
    <>
      <div className="pv-grid-3">
        <Field label="CPU cores">
          {({ id }) => <Input id={id} type="number" min={1} max={512} value={form.cpu} onChange={(e) => setForm({ ...form, cpu: Number(e.target.value) })} />}
        </Field>
        <Field label="Memory (MB)">
          {({ id }) => <Input id={id} type="number" min={256} step={256} value={form.ramMb} onChange={(e) => setForm({ ...form, ramMb: Number(e.target.value) })} />}
        </Field>
        <Field label="Disk (GB)">
          {({ id }) => <Input id={id} type="number" min={1} value={form.diskGb} onChange={(e) => setForm({ ...form, diskGb: Number(e.target.value) })} />}
        </Field>
      </div>
      <Field label="Storage" required hint="Storages that can hold VM images on the selected node.">
        {({ id }) => (
          <Select id={id} value={form.storage} onChange={(e) => setForm({ ...form, storage: e.target.value })}>
            <option value="">Select storage…</option>
            {(storage?.storage ?? []).filter((s) => s.content.includes("images")).map((s) => (
              <option key={s.node + s.storage} value={s.storage}>{s.storage} ({s.type}, node {s.node})</option>
            ))}
          </Select>
        )}
      </Field>
      <Checkbox
        label="Linked clone (faster; requires the base image on the same storage)"
        checked={form.linkedClone}
        onChange={(e) => setForm({ ...form, linkedClone: e.target.checked })}
      />
    </>,
    // 2: network
    <>
      <Field label="Node">
        {({ id }) => (
          <Select id={id} value={selNode} onChange={(e) => setForm({ ...form, node: e.target.value })}>
            {(nodes?.nodes ?? []).map((n) => (
              <option key={n.node} value={n.node}>{n.node} ({n.status})</option>
            ))}
          </Select>
        )}
      </Field>
      <div className="pv-grid-2">
        <Field label="Network bridge" required>
          {({ id }) => (
            <Select id={id} value={form.bridge} onChange={(e) => setForm({ ...form, bridge: e.target.value })}>
              <option value="">Select bridge…</option>
              {(networks?.networks ?? []).map((n) => (
                <option key={n.iface} value={n.iface}>{n.iface} ({n.type})</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="VLAN tag" hint="Blank = none (untagged).">
          {({ id }) => (
            <Input id={id} inputMode="numeric" placeholder="none" value={form.vlan} onChange={(e) => setForm({ ...form, vlan: e.target.value.replace(/[^0-9]/g, "") })} />
          )}
        </Field>
      </div>
      <Field label="Addressing">
        {({ id }) => (
          <Select id={id} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as "dhcp" | "static" })}>
            <option value="dhcp">DHCP</option>
            <option value="static">Static</option>
          </Select>
        )}
      </Field>
      {form.mode === "static" && (
        <div className="pv-grid-3">
          <Field label="IP address" required>
            {({ id, invalid }) => (
              <Input id={id} invalid={invalid} placeholder="10.0.0.5" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} />
            )}
          </Field>
          <Field label="CIDR">
            {({ id }) => <Input id={id} placeholder="24" value={form.cidr} onChange={(e) => setForm({ ...form, cidr: e.target.value })} />}
          </Field>
          <Field label="Gateway" required>
            {({ id, invalid }) => (
              <Input id={id} invalid={invalid} placeholder="10.0.0.1" value={form.gateway} onChange={(e) => setForm({ ...form, gateway: e.target.value })} />
            )}
          </Field>
        </div>
      )}
      <Field label="DNS servers" hint="Comma-separated. Leave blank for DHCP-provided resolvers.">
        {({ id }) => <Input id={id} placeholder="10.0.0.1, 1.1.1.1" value={form.dns} onChange={(e) => setForm({ ...form, dns: e.target.value })} />}
      </Field>
    </>,
    // 3: access
    <>
      <div className="pv-field">
        <span className="pv-label">Remote access protocols</span>
        {!form.templateId ? (
          <div className="pv-hint">Select a template in step 1 to choose protocols.</div>
        ) : (
          <div className="pv-inline">
            {supportedProtocols.map((p) => (
              <Checkbox
                key={p}
                label={p.toUpperCase()}
                checked={form.protocols.includes(p)}
                onChange={(e) => toggleProtocol(form.protocols, p, (v) => setForm({ ...form, protocols: v }))}
              />
            ))}
          </div>
        )}
      </div>
      <Field label="Guest user" required hint="cloud-init creates this account inside the guest.">
        {({ id }) => <Input id={id} value={form.guestUser} onChange={(e) => setForm({ ...form, guestUser: e.target.value })} />}
      </Field>
      {passwordBlock}
      {assignPicker}
    </>,
    // 4: review
    <ReviewSummary
      form={form}
      tmpl={tmpl ? { name: tmpl.name, osType: tmpl.osType, node: tmpl.node } : null}
      assignCount={assignIds.length}
    />,
  ];

  const canAdvance = advancedValid[step] ?? false;

  return (
    <Dialog
      title="Provision virtual machine"
      onClose={onClose}
      wide={mode === "advanced"}
      footer={
        mode === "basic" ? (
          <>
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn kind="primary" onClick={() => void submit()} disabled={!basicValid || submitting}>
              {submitting ? "Submitting…" : "Create VM"}
            </Btn>
          </>
        ) : (
          <>
            <Btn onClick={onClose}>Cancel</Btn>
            {step > 0 && <Btn onClick={() => setStep((s) => s - 1)}>Back</Btn>}
            {step < ADVANCED_STEPS.length - 1 ? (
              <Btn kind="primary" onClick={() => setStep((s) => s + 1)} disabled={!canAdvance}>
                Continue
              </Btn>
            ) : (
              <Btn kind="primary" onClick={() => void submit()} disabled={submitting}>
                {submitting ? "Submitting…" : "Start provisioning"}
              </Btn>
            )}
          </>
        )
      }
    >
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <div className="pv-seg" role="group" aria-label="Provisioning mode">
          <button className={`pv-seg-btn${mode === "basic" ? " pv-seg-btn-active" : ""}`} onClick={() => setMode("basic")}>
            Basic
          </button>
          <button className={`pv-seg-btn${mode === "advanced" ? " pv-seg-btn-active" : ""}`} onClick={() => { setMode("advanced"); setStep(0); }}>
            Advanced
          </button>
        </div>
      </div>
      {mode === "advanced" && (
        <ol style={{ display: "flex", gap: 6, listStyle: "none", margin: "0 0 16px", padding: 0, flexWrap: "wrap" }}>
          {ADVANCED_STEPS.map((s, i) => (
            <li
              key={s}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: "0.76rem",
                fontWeight: i === step ? 650 : 500,
                color: i === step ? "var(--pv-text)" : i < step ? "var(--pv-ok)" : "var(--pv-text-3)",
              }}
              aria-current={i === step ? "step" : undefined}
            >
              {i > 0 && <span aria-hidden="true" style={{ color: "var(--pv-text-3)" }}>·</span>}
              <span
                style={{
                  width: 17,
                  height: 17,
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.66rem",
                  border: `1px solid ${i === step ? "var(--pv-accent)" : i < step ? "var(--pv-ok-border)" : "var(--pv-border)"}`,
                  background: i === step ? "var(--pv-accent-soft)" : "transparent",
                  color: "inherit",
                }}
              >
                {i < step ? <Check size={10} aria-hidden="true" /> : i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>
      )}
      {mode === "basic" ? basicBody : stepBodies[step]}
    </Dialog>
  );
}

/* ============================== helpers ============================== */

function Stepper({ label, value, unit, min, max, step, onChange }: {
  label: string; value: number; unit: string; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ background: "var(--pv-inset)", border: "1px solid var(--pv-border-soft)", borderRadius: 6, padding: 10 }}>
      <div className="pv-label" style={{ marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Btn size="sm" disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))} aria-label={`Decrease ${label}`}>
          −
        </Btn>
        <span className="pv-mono" style={{ flex: 1, textAlign: "center" }}>
          {value} <span className="pv-faint">{unit}</span>
        </span>
        <Btn size="sm" disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))} aria-label={`Increase ${label}`}>
          +
        </Btn>
      </div>
    </div>
  );
}

function ReviewSummary({ form, tmpl, assignCount }: {
  form: { name: string; node: string; vmid: string; cpu: number; ramMb: number; diskGb: number; storage: string; bridge: string; vlan: string; mode: string; ip: string; cidr: string; gateway: string; dns: string; guestUser: string; linkedClone: boolean; protocols: string[] };
  tmpl: { name: string; osType: string; node: string } | null;
  assignCount: number;
}) {
  const rows = useMemo(() => {
    const out: Array<[string, string]> = [
      ["Name", form.name || "—"],
      ["Template", tmpl ? `${tmpl.name} (${tmpl.osType})` : "—"],
      ["Node", form.node || tmpl?.node || "—"],
      ["VM ID", form.vmid || "auto"],
      ["CPU", `${form.cpu} cores`],
      ["Memory", `${Math.round(form.ramMb / 1024)} GB`],
      ["Disk", `${form.diskGb} GB`],
      ["Storage", form.storage || "—"],
      ["Clone type", form.linkedClone ? "Linked clone" : "Full clone"],
      ["Network", `${form.bridge || "—"}${form.vlan ? ` · VLAN ${form.vlan}` : ""}`],
      [
        "Addressing",
        form.mode === "dhcp"
          ? "DHCP"
          : `Static ${form.ip}/${form.cidr} via ${form.gateway}${form.dns ? ` · DNS ${form.dns}` : ""}`,
      ],
      ["Guest user", form.guestUser || "—"],
      ["Protocols", form.protocols.length ? form.protocols.join(", ").toUpperCase() : "none"],
      ["Access granted to", assignCount ? `${assignCount} user(s)` : "no one else"],
    ];
    return out;
  }, [form, tmpl, assignCount]);
  return (
    <div>
      <div className="pv-hint" style={{ marginTop: 0, marginBottom: 10 }}>
        Review the provisioning request. Submitting enqueues a background job — progress is shown
        live and the VM appears in the list when Proxmox finishes.
      </div>
      <dl className="pv-kv" style={{ marginBottom: 4 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
