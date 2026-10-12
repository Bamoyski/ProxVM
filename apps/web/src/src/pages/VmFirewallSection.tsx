import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { Section, Empty, Btn, ErrorBox } from "../components/ui.js";

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
    <Section
      title="Network isolation"
      hint={data?.isolated
        ? "On — default-deny both ways; only the rules below (plus established return traffic) pass. Remote sessions keep working."
        : "Off — this VM can talk to anything on the network."}
    >
      {error && <ErrorBox error={error} />}
      {!data?.isolated && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end", marginBottom: 4 }}>
          <div className="pv-field" style={{ margin: 0 }}>
            <label className="pv-label">Allow remote access from</label>
            <input
              className="pv-input"
              style={{ width: 176 }}
              placeholder={data?.suggestedGuacdHost ?? "192.168.1.22"}
              value={allowFrom}
              onChange={(e) => setAllowFrom(e.target.value)}
            />
          </div>
          <div className="pv-field" style={{ margin: 0 }}>
            <label className="pv-label">Allow DNS to (optional)</label>
            <input
              className="pv-input"
              style={{ width: 144 }}
              placeholder="none"
              value={allowDnsTo}
              onChange={(e) => setAllowDnsTo(e.target.value)}
            />
          </div>
          <Btn size="sm" kind="primary" onClick={() => void toggle(true)}>Isolate this VM</Btn>
        </div>
      )}
      {data && data.isolated && (
        <>
          <div className="pv-mono" style={{ fontSize: "0.78rem", color: "var(--pv-text-2)", marginBottom: 8 }}>
            firewall {data.enabled ? "on" : "off"} · in:{data.policyIn ?? "?"} out:{data.policyOut ?? "?"}
            {data.otherRuleCount > 0 && <span> · +{data.otherRuleCount} hand-made rule(s) (untouched)</span>}
          </div>
          <div style={{ marginBottom: 12 }}>
            {data.proxvmRules.map((r) => (
              <div key={r.pos} className="pv-mono" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: "0.78rem", padding: "5px 0", borderBottom: "1px solid var(--pv-border-soft)" }}>
                <span style={{ color: "var(--pv-text-3)", width: 32 }}>#{r.pos}</span>
                <span>{r.action}</span>
                <span>{r.type}</span>
                <span>{r.proto || "any"}</span>
                <span>{r.dport || "any"}</span>
                <span style={{ color: "var(--pv-text-3)" }}>{r.source || ""}</span>
                <Btn size="sm" kind="link" onClick={() => void delRule(r.pos)}>Remove</Btn>
              </div>
            ))}
            {data.proxvmRules.length === 0 && (
              <Empty title="Pure deny — no accept rules" body="Remote sessions will fail until you add some below." />
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}>
            <select className="pv-select pv-input-auto" style={{ height: 32 }} value={rule.action} onChange={(e) => setRule({ ...rule, action: e.target.value })}>
              <option>ACCEPT</option>
              <option>DROP</option>
              <option>REJECT</option>
            </select>
            <select className="pv-select pv-input-auto" style={{ height: 32 }} value={rule.type} onChange={(e) => setRule({ ...rule, type: e.target.value })}>
              <option value="in">in</option>
              <option value="out">out</option>
            </select>
            <select className="pv-select pv-input-auto" style={{ height: 32 }} value={rule.proto} onChange={(e) => setRule({ ...rule, proto: e.target.value })}>
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
              <option value="icmp">icmp</option>
            </select>
            <input className="pv-input" style={{ width: 112 }} placeholder="port(s)" value={rule.dport} onChange={(e) => setRule({ ...rule, dport: e.target.value })} />
            <input className="pv-input" style={{ width: 144 }} placeholder="source IP/CIDR" value={rule.source} onChange={(e) => setRule({ ...rule, source: e.target.value })} />
            <Btn size="sm" onClick={() => void addRule()}>Add rule</Btn>
            <Btn size="sm" kind="link" onClick={() => void toggle(false)}>Remove isolation</Btn>
          </div>
        </>
      )}
    </Section>
  );
}
