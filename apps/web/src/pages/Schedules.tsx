import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox } from "../components/ui.js";

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

  const input = "bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm";

  return (
    <div>
      <PageTitle title="Scheduled Power Actions" />
      {error && <ErrorBox error={error} />}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-3">New schedule</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Virtual machine</label>
              <select className={`w-full ${input}`} value={form.vmId} onChange={(e) => setForm({ ...form, vmId: e.target.value })}>
                <option value="">Select VM…</option>
                {(vmsData?.vms ?? []).filter((v) => v.id).map((v) => (
                  <option key={v.id as string} value={v.id as string}>{v.name} ({v.vmid}@{v.node})</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Action</label>
                <select className={`w-full ${input}`} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
                  <option value="start">Start</option>
                  <option value="stop">Stop</option>
                  <option value="restart">Restart</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Hour</label>
                <input type="number" min={0} max={23} className={`w-full ${input}`} value={form.hour} onChange={(e) => setForm({ ...form, hour: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Minute</label>
                <input type="number" min={0} max={59} className={`w-full ${input}`} value={form.minute} onChange={(e) => setForm({ ...form, minute: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Days</label>
              <div className="flex flex-wrap gap-1">
                {DAYS.map((d, i) => (
                  <button
                    key={d}
                    onClick={() => setForm({ ...form, picked: form.picked.map((v, j) => (j === i ? !v : v)) })}
                    className={`px-2 py-1 text-xs rounded border ${form.picked[i] ? "bg-blue-600 border-blue-500 text-white" : "bg-slate-800 border-slate-700 text-slate-400"}`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={create}
              disabled={!form.vmId}
              className="w-full px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded"
            >
              Create schedule
            </button>
            <div className="text-xs text-slate-500">Runs are evaluated every minute; each schedule fires at most once per minute. Results are audited.</div>
          </div>
        </div>
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-3">All schedules</h2>
          <div className="space-y-2">
            {(schedData?.schedules ?? []).map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm border-b border-slate-800/50 py-2">
                <div>
                  <span className={`font-mono uppercase ${s.enabled ? "text-blue-300" : "text-slate-500"}`}>{s.action}</span>
                  <span className="ml-2">{vmName(s.vmId)}</span>
                  <span className="text-xs text-slate-500 ml-2">{fmtTime(s.hour, s.minute)} · {fmtDays(s.days)}</span>
                  {!s.enabled && <span className="text-xs text-slate-500 ml-2">(disabled)</span>}
                  {s.lastRunAt && <span className="text-xs text-slate-500 ml-2">last run {new Date(s.lastRunAt).toLocaleString()}</span>}
                </div>
                <div className="flex gap-2">
                  <button className="text-xs text-blue-400 underline" onClick={() => void toggle(s)}>
                    {s.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="text-xs text-red-300 underline" onClick={() => void remove(s)}>Delete</button>
                </div>
              </div>
            ))}
            {!(schedData?.schedules ?? []).length && <div className="text-sm text-slate-500">No schedules yet.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
