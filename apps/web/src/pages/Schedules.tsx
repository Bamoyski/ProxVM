import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { fmtDateTime, DAYS, fmtHM } from "../lib/format.js";
import {
  PageHeader, Section, EmptyState, Btn, Field, Input, Select, Badge,
  useConfirm, useToast, errText,
} from "../ui/index.js";

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

export default function Schedules() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({
    vmId: "",
    action: "stop",
    hour: "1",
    minute: "0",
    picked: [true, true, true, true, true, true, true] as boolean[],
  });

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

  // Same Sunday-first order the backend parses (DAYS in lib/format is Mon-first,
  // so keep the local mapping to the wire format untouched).
  const daysValue = form.picked.every(Boolean)
    ? "*"
    : form.picked.map((v, i) => (v ? i : -1)).filter((i) => i >= 0).join(",") || "*";

  const create = async () => {
    if (busy) return;
    setBusy("create");
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
      toast.ok("Schedule created", `${form.action} — checked every minute.`);
      setForm({ ...form, vmId: "" });
      reload();
    } catch (err) {
      toast.err("Create failed", errText(err));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (s: Schedule) => {
    setBusy(`toggle-${s.id}`);
    try {
      await api(`/schedules/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } });
      toast.info(s.enabled ? "Schedule disabled" : "Schedule enabled");
      reload();
    } catch (err) {
      toast.err("Toggle failed", errText(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (s: Schedule) => {
    const ok = await confirm({
      title: "Delete this schedule?",
      danger: true,
      confirmLabel: "Delete schedule",
      body: `${s.action} at ${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")} — the VM stops being touched on this timetable. Past run history stays in the audit log.`,
    });
    if (!ok) return;
    setBusy(`del-${s.id}`);
    try {
      await api(`/schedules/${s.id}`, { method: "DELETE" });
      toast.ok("Schedule deleted");
      reload();
    } catch (err) {
      toast.err("Delete failed", errText(err));
    } finally {
      setBusy(null);
    }
  };

  const vmName = (vmId: string): string => {
    const vm = (vmsData?.vms ?? []).find((v) => v.id === vmId);
    return vm ? `${vm.name} (${vm.vmid}@${vm.node})` : vmId.slice(0, 8);
  };

  const localDays = (raw: string): string => {
    // Convert the wire format (0=Sun) into the shared Mon-first day labels.
    if (raw === "*") return "daily";
    return raw
      .split(",")
      .map((d) => {
        const idx = Number(d);
        const sunFirst = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        return sunFirst[idx] ?? d;
      })
      .join(", ");
  };

  return (
    <div className="pv-page">
      <PageHeader
        title="Scheduled power actions"
        description="Start, stop, or restart VMs on a timetable. Evaluated every minute; audited on fire."
      />
      <div className="pv-grid-2">
        <Section title="New schedule" hint="Times are server-local. Each schedule fires at most once per minute.">
          <Field label="Virtual machine" required>
            {({ id }) => (
              <Select id={id} value={form.vmId} onChange={(e) => setForm({ ...form, vmId: e.target.value })}>
                <option value="">Select VM…</option>
                {(vmsData?.vms ?? []).filter((v) => v.id).map((v) => (
                  <option key={v.id as string} value={v.id as string}>{v.name} ({v.vmid}@{v.node})</option>
                ))}
              </Select>
            )}
          </Field>
          <div className="pv-grid-3">
            <Field label="Action">
              {({ id }) => (
                <Select id={id} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
                  <option value="start">Start</option>
                  <option value="stop">Stop</option>
                  <option value="restart">Restart</option>
                </Select>
              )}
            </Field>
            <Field label="Hour">
              {({ id }) => (
                <Input id={id} type="number" min={0} max={23} value={form.hour} onChange={(e) => setForm({ ...form, hour: e.target.value })} />
              )}
            </Field>
            <Field label="Minute">
              {({ id }) => (
                <Input id={id} type="number" min={0} max={59} value={form.minute} onChange={(e) => setForm({ ...form, minute: e.target.value })} />
              )}
            </Field>
          </div>
          <div className="pv-field">
            <span className="pv-label">Days</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {DAYS.map((d, i) => (
                <button
                  key={d}
                  onClick={() => setForm({ ...form, picked: form.picked.map((v, j) => (j === i ? !v : v)) })}
                  className={`pv-seg-btn${form.picked[i] ? " pv-seg-btn-active" : ""}`}
                  aria-pressed={form.picked[i]}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="pv-hint">
              Wire format: {daysValue === "*" ? "daily (every day)" : daysValue} — evaluated on the server's clock.
            </div>
          </div>
          <Btn kind="primary" loading={busy === "create"} onClick={() => void create()} disabled={!form.vmId}>
            Create schedule
          </Btn>
        </Section>

        <Section title="All schedules" hint={`${(schedData?.schedules ?? []).length} total`}>
          {(schedData?.schedules ?? []).map((s) => (
            <div
              key={s.id}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8,
                padding: "9px 0",
                borderBottom: "1px solid var(--pv-border-soft)",
                fontSize: "0.85rem",
              }}
            >
              <Badge tone={s.enabled ? "ok" : "neutral"}>{s.action}</Badge>
              <span>{vmName(s.vmId)}</span>
              <span className="pv-faint" style={{ fontSize: "0.78rem" }}>
                {fmtHM(s.hour, s.minute)} · {localDays(s.days)}
              </span>
              {s.lastRunAt && (
                <span className="pv-faint" style={{ fontSize: "0.78rem" }}>last run {fmtDateTime(s.lastRunAt)}</span>
              )}
              <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <Btn size="sm" kind="link" loading={busy === `toggle-${s.id}`} onClick={() => void toggle(s)}>
                  {s.enabled ? "Disable" : "Enable"}
                </Btn>
                <Btn size="sm" kind="link" loading={busy === `del-${s.id}`} onClick={() => void remove(s)}>Delete</Btn>
              </span>
            </div>
          ))}
          {!(schedData?.schedules ?? []).length && (
            <EmptyState
              title="No schedules yet"
              body="Power actions on a timetable — e.g. stop lab VMs at night."
            />
          )}
        </Section>
      </div>
    </div>
  );
}
