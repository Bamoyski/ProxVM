import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { usePref } from "../prefs.js";
import { PageTitle, ErrorBox, Section, Empty, Btn } from "../components/ui.js";

interface OverviewRow {
  vmId: string;
  name: string;
  vmid: number;
  node: string;
  schedules: number;
  enabledSchedules: number;
  lastRun: { status: string; kind: string; createdAt: string } | null;
  lastSnapshot: string | null;
  snapshotCount: number | null;
}

interface BackupSchedule {
  id: string;
  vmId: string;
  mode: string;
  storage: string;
  datastore: string | null;
  minute: number;
  hour: number;
  days: string;
  keepLast: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

interface BackupRun {
  id: string;
  kind: string;
  status: string;
  error: string | null;
  createdAt: string;
}

interface Snapshot {
  backupId: string;
  backupType: string | null;
  backupCount: number | null;
  lastBackup: string | null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const FREQUENCIES = [
  { label: "Every day", days: "*" },
  { label: "Weekdays (Mon–Fri)", days: "1,2,3,4,5" },
  { label: "Weekends (Sat–Sun)", days: "6,0" },
  { label: "Sundays only", days: "0" },
];

const KEEP_OPTIONS = [
  { label: "Keep everything", value: "" },
  { label: "Keep newest 3", value: "3" },
  { label: "Keep newest 4", value: "4" },
  { label: "Keep newest 7", value: "7" },
  { label: "Keep newest 14", value: "14" },
  { label: "Keep newest 30", value: "30" },
];

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0"));

const PRESETS = [
  { label: "Nightly · keep 7", hour: "02", minute: "00", frequency: "Every day", keepLast: "7" },
  { label: "Weekly Sun · keep 4", hour: "03", minute: "00", frequency: "Sundays only", keepLast: "4" },
  { label: "Daily noon · keep 14", hour: "12", minute: "00", frequency: "Every day", keepLast: "14" },
];

function fmtDays(days: string): string {
  if (days === "*") return "daily";
  return days.split(",").map((d) => DAYS[Number(d)] ?? d).join(", ");
}

function fmtTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function pill(text: string, tone: "ok" | "warn" | "bad" | "idle"): React.ReactNode {
  const color =
    tone === "ok" ? "var(--pv-ok, #3a3)" : tone === "warn" ? "var(--pv-warn, #b80)" : tone === "bad" ? "var(--pv-danger, #c00)" : "var(--pv-text-3)";
  return (
    <span style={{ color, fontSize: "0.78rem", border: "1px solid currentColor", borderRadius: 10, padding: "0 8px", whiteSpace: "nowrap" }}>
      {text}
    </span>
  );
}

function runTone(status: string): "ok" | "warn" | "bad" | "idle" {
  if (status === "OK") return "ok";
  if (status === "FAILED") return "bad";
  return "warn";
}

export default function Backups() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [focusId, setFocusId] = useState("");
  const [backupSearch, setBackupSearch] = usePref("backups-search", "");
  // Last-used timetable survives reloads (server still validates everything).
  const [form, setForm] = usePref("backups-form", { mode: "snapshot", storage: "", hour: "02", minute: "00", frequency: "Every day", keepLast: "7" });

  const { data: overviewData } = useQuery({
    queryKey: ["backup-overview"],
    queryFn: () => api<{ overview: OverviewRow[] }>("/backups/overview"),
    refetchInterval: 30000,
  });
  const { data: schedData } = useQuery({
    queryKey: ["backup-schedules"],
    queryFn: () => api<{ schedules: BackupSchedule[] }>("/backups/schedules"),
  });
  const rows = overviewData?.overview ?? [];
  const q = backupSearch.trim().toLowerCase();
  const fleet = q
    ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.node.toLowerCase().includes(q) || String(r.vmid).includes(q))
    : rows;

  // Backup-capable Proxmox storages on the selected VMs' nodes, for the
  // destination dropdown (no guessing storage IDs).
  const nodes = [...new Set(checked.map((id) => rows.find((r) => r.vmId === id)?.node).filter((n): n is string => !!n))];
  const { data: storageData } = useQuery({
    queryKey: ["backup-storages", nodes.sort().join(",")],
    queryFn: async () => {
      const names = new Map<string, number>();
      await Promise.all(
        nodes.map(async (node) => {
          try {
            const res = await api<{ storage: Array<{ storage: string; type: string | null }> }>(
              `/proxmox/storage?node=${encodeURIComponent(node)}`,
            );
            for (const s of res.storage ?? []) {
              if ((s.type ?? "").toLowerCase() === "pbs" && s.storage) {
                names.set(s.storage, (names.get(s.storage) ?? 0) + 1);
              }
            }
          } catch {
            // A node that can't be listed just contributes no suggestions.
          }
        }),
      );
      // Suggest storages present on every selected node first.
      return [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
    },
    enabled: nodes.length > 0,
  });
  const storageOptions = storageData ?? [];
  const storageValue = storageOptions.includes(form.storage) || !form.storage ? form.storage : "";

  const focus = focusId || checked[0] || "";
  const focusRow = rows.find((r) => r.vmId === focus);

  const { data: runsData } = useQuery({
    queryKey: ["backup-runs", focus],
    queryFn: () => api<{ runs: BackupRun[] }>(`/vms/${focus}/backups/runs?limit=10`),
    enabled: !!focus,
  });
  const { data: snapsData } = useQuery({
    queryKey: ["backup-snapshots", focus],
    queryFn: () => api<{ snapshots: Snapshot[] }>(`/vms/${focus}/backups/snapshots`),
    enabled: !!focus,
  });

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["backup-overview"] });
    void qc.invalidateQueries({ queryKey: ["backup-schedules"] });
    void qc.invalidateQueries({ queryKey: ["backup-runs"] });
    void qc.invalidateQueries({ queryKey: ["backup-snapshots"] });
  };

  const call = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      const res = await fn();
      reload();
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const toggleCheck = (id: string) =>
    setChecked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const daysValue = FREQUENCIES.find((f) => f.label === form.frequency)?.days ?? "*";

  const keepValue = form.keepLast.trim() ? Number(form.keepLast) : null;

  // Plain-language preview of what the buttons below will do.
  const summary = checked.length === 0
    ? "Tick one or more VMs above first."
    : `${checked.length} VM${checked.length === 1 ? "" : "s"} · ${form.frequency.toLowerCase()} at ${form.hour}:${form.minute} server time · ${form.mode} backups to “${storageValue || "…" }”${keepValue ? ` · keeps newest ${keepValue}, deletes older` : " · keeps everything"}`;

  const schedulePayload = () => ({
    mode: form.mode,
    storage: storageValue.trim(),
    hour: Number(form.hour),
    minute: Number(form.minute),
    days: daysValue,
    keepLast: keepValue,
  });

  const createBulk = () =>
    call(() =>
      api<{ created: unknown[]; failed: Array<{ vmId: string; error: string }> }>("/backups/schedules/bulk", {
        method: "POST",
        body: { vmIds: checked, ...schedulePayload() },
      }).then((res) => {
        if (res.failed.length) {
          setError(`${res.created.length} scheduled, ${res.failed.length} failed: ${res.failed.map((f) => f.error).join("; ").slice(0, 300)}`);
        }
      }),
    );

  const runBulk = () =>
    call(() =>
      api<{ queued: unknown[]; failed: Array<{ vmId: string; error: string }> }>("/backups/run-bulk", {
        method: "POST",
        body: { vmIds: checked, mode: form.mode, storage: storageValue.trim() },
      }).then((res) => {
        if (res.failed.length) {
          setError(`${res.queued.length} queued, ${res.failed.length} failed: ${res.failed.map((f) => f.error).join("; ").slice(0, 300)}`);
        }
      }),
    );

  return (
    <div className="pv-page">
      <PageTitle title="PBS backups" description="Tick VMs, then back them all up or put them on one timetable. Schedules and runs are per-VM underneath." />
      {error && <ErrorBox error={error} />}
      <Section
        title="Fleet"
        hint={`${rows.length} VMs · ${checked.length} selected`}
      >
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <input
            className="pv-input"
            style={{ maxWidth: 260 }}
            placeholder="Search name, node, ID…"
            value={backupSearch}
            onChange={(e) => setBackupSearch(e.target.value)}
            aria-label="Search fleet"
          />
          <Btn size="sm" onClick={() => setChecked(fleet.map((r) => r.vmId))} disabled={!fleet.length}>Select all</Btn>
          <Btn size="sm" kind="link" onClick={() => setChecked([])} disabled={!checked.length}>Clear</Btn>
          <span style={{ flex: 1 }} />
          <Btn size="sm" kind="primary" disabled={!checked.length || !storageValue.trim()} onClick={() => void runBulk()}>
            Back up selected now{checked.length ? ` (${checked.length})` : ""}
          </Btn>
        </div>
        {fleet.map((r) => (
          <div
            key={r.vmId}
            onClick={() => setFocusId(r.vmId)}
            style={{
              display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "8px 6px",
              borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem",
              cursor: "pointer", background: focus === r.vmId ? "var(--pv-surface-2, transparent)" : undefined,
            }}
          >
            <input
              type="checkbox"
              checked={checked.includes(r.vmId)}
              onChange={() => toggleCheck(r.vmId)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${r.name}`}
            />
            <span style={{ fontWeight: 600 }}>{r.name}</span>
            <span style={{ color: "var(--pv-text-3)", fontSize: "0.78rem" }} className="pv-mono">{r.vmid}@{r.node}</span>
            {r.schedules ? pill(`${r.enabledSchedules}/${r.schedules} scheduled`, "ok") : pill("no schedule", "idle")}
            {r.lastRun ? pill(`${r.lastRun.kind} ${r.lastRun.status}`, runTone(r.lastRun.status)) : pill("never run", "idle")}
            {r.lastSnapshot
              ? <span style={{ color: "var(--pv-text-3)", fontSize: "0.78rem" }}>snapshot {new Date(r.lastSnapshot).toLocaleString()}</span>
              : pill("no snapshots", "idle")}
          </div>
        ))}
        {!fleet.length && <Empty title={rows.length ? "No matches" : "No VMs visible"} body={rows.length ? "Try a different search." : "VMs you can manage appear here."} />}
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-x-10">
        <Section title={`Schedule backups${checked.length ? ` for ${checked.length} selected` : ""}`}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className="pv-btn pv-btn-sm"
                onClick={() => setForm({ ...form, hour: p.hour, minute: p.minute, frequency: p.frequency, keepLast: p.keepLast })}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="pv-field">
            <label className="pv-label">How should the backup run?</label>
            <select className="pv-select" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="snapshot">Snapshot — safe while running</option>
              <option value="suspend">Suspend — pauses the VM briefly</option>
              <option value="stop">Stop — powers the VM off first</option>
            </select>
          </div>
          <div className="pv-field">
            <label className="pv-label">Back up to (backup storage)</label>
            <select
              className="pv-select"
              value={storageValue}
              onChange={(e) => setForm({ ...form, storage: e.target.value })}
            >
              <option value="">{storageOptions.length ? "Choose storage…" : "No backup storage found — type it"}</option>
              {storageOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            {!storageOptions.length && (
              <input
                className="pv-input"
                style={{ marginTop: 6 }}
                placeholder="Storage ID, e.g. pbs-store"
                value={form.storage}
                onChange={(e) => setForm({ ...form, storage: e.target.value })}
              />
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="pv-field">
              <label className="pv-label">How often?</label>
              <select className="pv-select" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                {FREQUENCIES.map((f) => (
                  <option key={f.label} value={f.label}>{f.label}</option>
                ))}
              </select>
            </div>
            <div className="pv-field">
              <label className="pv-label">At hour</label>
              <select className="pv-select" value={form.hour} onChange={(e) => setForm({ ...form, hour: e.target.value })}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>{h}:00</option>
                ))}
              </select>
            </div>
            <div className="pv-field">
              <label className="pv-label">At minute</label>
              <select className="pv-select" value={form.minute} onChange={(e) => setForm({ ...form, minute: e.target.value })}>
                {MINUTES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="pv-field">
            <label className="pv-label">How many to keep?</label>
            <select className="pv-select" value={form.keepLast} onChange={(e) => setForm({ ...form, keepLast: e.target.value })}>
              {KEEP_OPTIONS.map((k) => (
                <option key={k.label} value={k.value}>{k.label}</option>
              ))}
            </select>
          </div>
          <div className="pv-hint" style={{ marginBottom: 8 }}>{summary}</div>
          <Btn kind="primary" style={{ width: "100%" }} disabled={!checked.length || !storageValue.trim()} onClick={() => void createBulk()}>
            {checked.length ? `Schedule backups for ${checked.length} VM${checked.length === 1 ? "" : "s"}` : "Tick VMs above first"}
          </Btn>
        </Section>
        <div className="lg:col-span-2">
          <Section title="All backup schedules" hint={`${(schedData?.schedules ?? []).length} total`}>
            {(schedData?.schedules ?? []).slice(0, 30).map((s) => (
              <div key={s.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
                <span className="pv-mono" style={{ textTransform: "uppercase" }}>{s.mode}</span>
                <span>{rows.find((r) => r.vmId === s.vmId)?.name ?? s.vmId.slice(0, 8)}</span>
                <span style={{ color: "var(--pv-text-3)", fontSize: "0.78rem" }}>{fmtTime(s.hour, s.minute)} · {s.days === "*" ? "daily" : s.days}{s.keepLast ? ` · keep ${s.keepLast}` : ""}</span>
                {!s.enabled && <span style={{ color: "var(--pv-text-3)", fontSize: "0.78rem" }}>(disabled)</span>}
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <Btn size="sm" kind="link" onClick={() => void call(() => api(`/backups/schedules/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } }))}>
                    {s.enabled ? "Disable" : "Enable"}
                  </Btn>
                  <Btn size="sm" kind="link" onClick={() => void call(() => api(`/backups/schedules/${s.id}`, { method: "DELETE" }))}>Delete</Btn>
                </span>
              </div>
            ))}
            {!(schedData?.schedules ?? []).length && <Empty title="No backup schedules yet" body="Tick VMs above, pick the nightly preset, schedule." />}
          </Section>
          {focusRow && (
            <Section title={`Latest activity — ${focusRow.name}`}>
              {(runsData?.runs ?? []).slice(0, 5).map((r) => (
                <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", fontSize: "0.85rem" }}>
                  {pill(`${r.kind} ${r.status}`, runTone(r.status))}
                  <span style={{ color: "var(--pv-text-3)", fontSize: "0.78rem" }}>{new Date(r.createdAt).toLocaleString()}</span>
                  {r.error && <span style={{ color: "var(--pv-danger, #c00)", fontSize: "0.78rem" }}>{r.error.slice(0, 160)}</span>}
                </div>
              ))}
              {!(runsData?.runs ?? []).length && <Empty title="No runs yet" body="Trigger a backup or wait for a schedule." />}
              {(snapsData?.snapshots ?? []).length > 0 && (
                <div style={{ marginTop: 6, fontSize: "0.85rem", color: "var(--pv-text-3)" }}>
                  Snapshots: {(snapsData?.snapshots ?? []).map((s) => s.backupId).join(", ")}
                </div>
              )}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
