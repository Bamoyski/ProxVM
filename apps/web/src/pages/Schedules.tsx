import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox, Section, Empty, Btn } from "../components/ui.js";

interface Schedule {
  id: string;
  vmId: string;
  action: string;
  minute: number;
  hour: number;
  days: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

interface VmOption {
  id: string | null;
  name: string;
  vmid: number;
  node: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtDays(days: string): string {
  if (days === "*") return "daily";
  return days
    .split(",")
    .map((d) => DAYS[Number(d)] ?? d)
    .join(", ");
}

function fmtTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export default function Schedules() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ vmId: "", action: "stop", hour: "1", minute: "0", days: "*",
    picked: [true, true, true, true, true, true, true] as boolean[] });

  const { data: schedData } = useQuery({
    queryKey: ["schedules"],
    queryFn: () => api<{ schedules: Schedule[] }>("/schedules"),
  });
  const { data: vmsData } = useQuery({
    queryKey: ["vms"],
    queryFn: () => api<{ vms: VmOption[] }>("/vms"),
  });

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["schedules"] });
  };

  const daysValue = form.picked.every(Boolean)
    ? "*"
    : form.picked.map((v, i) => (v ? i : -1)).filter((i) => i >= 0).join(",") || "*";

  const create = async () => {
    setError(null);
    try {
      await api("/schedules", {
        method: "POST",
        body: {
          vmId: form.vmId,
          action: form.action,
          hour: Number(form.hour),
          minute: Number(form.minute),
          days: daysValue,
        },
      });
      setForm({ ...form, vmId: "" });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggle = async (s: Schedule) => {
    setError(null);
    try {
      await api(`/schedules/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (s: Schedule) => {
    setError(null);
    try {
      await api(`/schedules/${s.id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const vmName = (vmId: string): string => {
    const vm = (vmsData?.vms ?? []).find((v) => v.id === vmId);
    return vm ? `${vm.name} (${vm.vmid}@${vm.node})` : vmId.slice(0, 8);
  };

  return (
    <div className="pv-page">
      <PageTitle title="Scheduled power actions" description="Start, stop, or restart VMs on a timetable. Evaluated every minute; audited on fire." />
      {error && <ErrorBox error={error} />}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-x-10">
        <Section title="New schedule">
          <div className="pv-field">
            <label className="pv-label">Virtual machine</label>
            <select className="pv-select" value={form.vmId} onChange={(e) => setForm({ ...form, vmId: e.target.value })}>
              <option value="">Select VM…</option>
              {(vmsData?.vms ?? []).filter((v) => v.id).map((v) => (
                <option key={v.id as string} value={v.id as string}>{v.name} ({v.vmid}@{v.node})</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="pv-field">
              <label className="pv-label">Action</label>
              <select className="pv-select" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
                <option value="start">Start</option>
                <option value="stop">Stop</option>
                <option value="restart">Restart</option>
              </select>
            </div>
            <div className="pv-field">
              <label className="pv-label">Hour</label>
              <input type="number" min={0} max={23} className="pv-input" value={form.hour} onChange={(e) => setForm({ ...form, hour: e.target.value })} />
            </div>
            <div className="pv-field">
              <label className="pv-label">Minute</label>
              <input type="number" min={0} max={59} className="pv-input" value={form.minute} onChange={(e) => setForm({ ...form, minute: e.target.value })} />
            </div>
          </div>
          <div className="pv-field">
            <label className="pv-label">Days</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {DAYS.map((d, i) => (
                <button
                  key={d}
                  onClick={() => setForm({ ...form, picked: form.picked.map((v, j) => (j === i ? !v : v)) })}
                  className={form.picked[i] ? "pv-btn pv-btn-primary pv-btn-sm" : "pv-btn pv-btn-sm"}
                  aria-pressed={form.picked[i]}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          <Btn kind="primary" style={{ width: "100%" }} onClick={create} disabled={!form.vmId}>
            Create schedule
          </Btn>
          <div className="pv-hint" style={{ marginTop: 8 }}>Each schedule fires at most once per minute. Results are audited.</div>
        </Section>
        <div className="lg:col-span-2">
          <Section title="All schedules" hint={`${(schedData?.schedules ?? []).length} total`}>
            {(schedData?.schedules ?? []).map((s) => (
              <div key={s.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
                <span className="pv-mono" style={{ textTransform: "uppercase", color: s.enabled ? "var(--pv-text)" : "var(--pv-text-3)" }}>{s.action}</span>
                <span>{vmName(s.vmId)}</span>
                <span style={{ color: "var(--pv-text-3)", fontSize: "0.78rem" }}>{fmtTime(s.hour, s.minute)} · {fmtDays(s.days)}</span>
                {!s.enabled && <span style={{ color: "var(--pv-text-3)", fontSize: "0.78rem" }}>(disabled)</span>}
                {s.lastRunAt && <span style={{ color: "var(--pv-text-3)", fontSize: "0.78rem" }}>last run {new Date(s.lastRunAt).toLocaleString()}</span>}
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <Btn size="sm" kind="link" onClick={() => void toggle(s)}>
                    {s.enabled ? "Disable" : "Enable"}
                  </Btn>
                  <Btn size="sm" kind="link" onClick={() => void remove(s)}>Delete</Btn>
                </span>
              </div>
            ))}
            {!(schedData?.schedules ?? []).length && <Empty title="No schedules yet" body="Power actions on a timetable — e.g. stop lab VMs at night." />}
          </Section>
        </div>
      </div>
    </div>
  );
}
