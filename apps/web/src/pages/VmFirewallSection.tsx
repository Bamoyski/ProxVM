import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { ErrorBox } from "../components/ui.js";

interface FirewallRule {
  pos: number;
  type: string;
  action: string;
  proto: string;
  dport: string;
  source: string;
}

interface FirewallStatus {
  isolated: boolean;
  enabled: boolean;
  policyIn: string | null;
  policyOut: string | null;
  proxvmRules: FirewallRule[];
  otherRuleCount: number;
  suggestedGuacdHost: string | null;
}

const input = "bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm";

export default function VmFirewallSection({ vmId }: { vmId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [allowFrom, setAllowFrom] = useState("");
  const [allowDnsTo, setAllowDnsTo] = useState("");
  const [rule, setRule] = useState({ action: "ACCEPT", type: "in", proto: "tcp", dport: "", source: "" });
  const { data } = useQuery({
    queryKey: ["vm-firewall", vmId],
    queryFn: () => api<FirewallStatus>(`/vms/${vmId}/firewall`),
  });

  const reload = () => void qc.invalidateQueries({ queryKey: ["vm-firewall", vmId] });
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const toggle = async (isolated: boolean) => {
    setError(null);
    try {
      await api(`/vms/${vmId}/firewall`, {
        method: "POST",
        body: isolated
          ? {
              isolated: true,
              allowFrom: (allowFrom || data?.suggestedGuacdHost || "").trim() || undefined,
              allowDnsTo: allowDnsTo.trim() || undefined,
            }
          : { isolated: false },
      });
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const addRule = async () => {
    setError(null);
    try {
      await api(`/vms/${vmId}/firewall/rules`, {
        method: "POST",
        body: {
          action: rule.action,
          type: rule.type,
          proto: rule.proto || undefined,
          dport: rule.dport.trim() || undefined,
          source: rule.source.trim() || undefined,
        },
      });
      setRule({ action: "ACCEPT", type: "in", proto: "tcp", dport: "", source: "" });
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const delRule = async (pos: number) => {
    setError(null);
    try {
      await api(`/vms/${vmId}/firewall/rules/${pos}`, { method: "DELETE" });
      reload();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-4 mb-6">
      <div className="text-sm font-medium text-slate-300 mb-1">Network isolation</div>
      <div className="text-xs text-slate-500 mb-3">
        {data?.isolated
          ? "🔒 On — default-deny both ways; only the rules below (plus established return traffic) pass. Remote sessions keep working."
          : "Off — this VM can talk to anything on the network. Turning isolation on keeps remote sessions working while blocking everything else."}
      </div>
      {error && <ErrorBox error={error} />}
      {!data?.isolated && (
        <div className="flex flex-wrap gap-2 items-end mb-2">
          <label className="text-xs text-slate-400">
            Allow remote access from
            <input
              className={`${input} ml-2 w-44`}
              placeholder={data?.suggestedGuacdHost ?? "192.168.1.22"}
              value={allowFrom}
              onChange={(e) => setAllowFrom(e.target.value)}
            />
          </label>
          <label className="text-xs text-slate-400">
            Allow DNS to (optional)
            <input
              className={`${input} ml-2 w-36`}
              placeholder="none"
              value={allowDnsTo}
              onChange={(e) => setAllowDnsTo(e.target.value)}
            />
          </label>
          <button onClick={() => void toggle(true)} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded">
            Isolate this VM
          </button>
        </div>
      )}
      {data && data.isolated && (
        <>
          <div className="text-xs text-slate-400 mb-2 font-mono">
            firewall {data.enabled ? "on" : "off"} · in:{data.policyIn ?? "?"} out:{data.policyOut ?? "?"}
            {data.otherRuleCount > 0 && <span> · +{data.otherRuleCount} hand-made rule(s) (untouched)</span>}
          </div>
          <div className="space-y-1 mb-3">
            {data.proxvmRules.map((r) => (
              <div key={r.pos} className="flex items-center gap-2 text-xs font-mono text-slate-300">
                <span className="text-slate-500 w-8">#{r.pos}</span>
                <span>{r.action}</span>
                <span>{r.type}</span>
                <span>{r.proto || "any"}</span>
                <span>{r.dport || "any"}</span>
                <span className="text-slate-500">{r.source || ""}</span>
                <button className="text-xs text-red-300 underline ml-auto" onClick={() => void delRule(r.pos)}>
                  Remove
                </button>
              </div>
            ))}
            {data.proxvmRules.length === 0 && (
              <div className="text-xs text-slate-500">Pure deny — no accept rules. Remote sessions will fail until you add some below.</div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            <select className={input} value={rule.action} onChange={(e) => setRule({ ...rule, action: e.target.value })}>
              <option>ACCEPT</option>
              <option>DROP</option>
              <option>REJECT</option>
            </select>
            <select className={input} value={rule.type} onChange={(e) => setRule({ ...rule, type: e.target.value })}>
              <option value="in">in</option>
              <option value="out">out</option>
            </select>
            <select className={input} value={rule.proto} onChange={(e) => setRule({ ...rule, proto: e.target.value })}>
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
              <option value="icmp">icmp</option>
            </select>
            <input className={`${input} w-28`} placeholder="port(s)" value={rule.dport} onChange={(e) => setRule({ ...rule, dport: e.target.value })} />
            <input className={`${input} w-36`} placeholder="source IP/CIDR" value={rule.source} onChange={(e) => setRule({ ...rule, source: e.target.value })} />
            <button onClick={() => void addRule()} className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 rounded">
              Add rule
            </button>
            <button onClick={() => void toggle(false)} className="px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 rounded ml-auto">
              Remove isolation
            </button>
          </div>
        </>
      )}
    </div>
  );
}
