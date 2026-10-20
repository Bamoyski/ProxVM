import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { Section, EmptyState, Btn, Field, Input, Select, Checkbox, Alert, useToast, errText, Spinner } from "../ui/index.js";

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

/**
 * Per-VM isolation firewall: deny-by-default ingress with explicit accept
 * rules, applied inside Proxmox (not here). Rules ProxVM did not create are
 * counted but never touched.
 */
export default function VmFirewallSection({ vmId }: { vmId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [allowFrom, setAllowFrom] = useState("");
  const [allowDnsTo, setAllowDnsTo] = useState("");
  const [allowInternet, setAllowInternet] = useState(true);
  const [rule, setRule] = useState({ action: "ACCEPT", type: "in", proto: "tcp", dport: "", source: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["vm-firewall", vmId],
    queryFn: () => api<FirewallStatus>(`/vms/${vmId}/firewall`),
  });

  const reload = () => void qc.invalidateQueries({ queryKey: ["vm-firewall", vmId] });

  const toggle = async (isolated: boolean) => {
    setBusy("toggle");
    try {
      await api(`/vms/${vmId}/firewall`, {
        method: "POST",
        body: isolated
          ? {
              isolated: true,
              allowFrom: (allowFrom || data?.suggestedGuacdHost || "").trim() || undefined,
              allowDnsTo: allowDnsTo.trim() || undefined,
              allowInternet,
            }
          : { isolated: false },
      });
      toast.ok(
        isolated ? "Isolation applied" : "Isolation removed",
        isolated
          ? "Local-network access is blocked; DNS/internet rules follow your choices."
          : "The VM can reach the local network again.",
      );
      reload();
    } catch (err) {
      toast.err(isolated ? "Isolation failed" : "Removal failed", errText(err));
    } finally {
      setBusy(null);
    }
  };

  const addRule = async () => {
    setBusy("add");
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
      toast.err("Rule add failed", errText(err));
    } finally {
      setBusy(null);
    }
  };

  const delRule = async (pos: number) => {
    setBusy(`del-${pos}`);
    try {
      await api(`/vms/${vmId}/firewall/rules/${pos}`, { method: "DELETE" });
      reload();
    } catch (err) {
      toast.err("Rule removal failed", errText(err));
    } finally {
      setBusy(null);
    }
  };

  if (isLoading && !data) {
    return (
      <Section title="Network isolation" hint="Loading firewall state…">
        <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--pv-text-3)" }}>
          <Spinner size={14} /> Reading Proxmox firewall configuration…
        </div>
      </Section>
    );
  }

  return (
    <Section
      title="Network isolation"
      hint={
        data?.isolated
          ? "On — the guest can use DNS and the internet but cannot reach the local network. Remote sessions keep working."
          : "Off — this VM can talk to anything on the network."
      }
    >
      {!data?.isolated && (
        <div>
          <div className="pv-grid-3" style={{ marginBottom: 10 }}>
            <Field label="Allow remote access from" hint="Guacamole's daemon host (auto-detected when possible).">
              {({ id }) => (
                <Input
                  id={id}
                  placeholder={data?.suggestedGuacdHost ?? "192.168.1.22"}
                  value={allowFrom}
                  onChange={(e) => setAllowFrom(e.target.value)}
                />
              )}
            </Field>
            <Field label="Allow DNS to" hint="The resolver the guest may query.">
              {({ id }) => (
                <Input
                  id={id}
                  placeholder="e.g. 192.168.1.1"
                  value={allowDnsTo}
                  onChange={(e) => setAllowDnsTo(e.target.value)}
                />
              )}
            </Field>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <Btn kind="primary" loading={busy === "toggle"} onClick={() => void toggle(true)}>
                Isolate this VM
              </Btn>
            </div>
          </div>
          <Checkbox
            label="Allow internet (block local network only)"
            checked={allowInternet}
            onChange={(e) => setAllowInternet(e.target.checked)}
          />
          {!allowInternet && (
            <div className="pv-hint">Off = DNS only. The guest gets no internet and no local network.</div>
          )}
        </div>
      )}

      {data && data.isolated && (
        <>
          <div className="pv-mono" style={{ fontSize: "0.78rem", color: "var(--pv-text-2)", marginBottom: 10 }}>
            firewall {data.enabled ? "on" : "off"} · in:{data.policyIn ?? "?"} out:{data.policyOut ?? "?"}
            {data.otherRuleCount > 0 && <span> · +{data.otherRuleCount} hand-made rule(s) (untouched)</span>}
          </div>

          {data.proxvmRules.length === 0 ? (
            <EmptyState
              title="Pure deny — no accept rules"
              body="Remote sessions will fail until you add an accept rule below."
            />
          ) : (
            <div className="pv-table-wrap" style={{ marginBottom: 14 }}>
              <table className="pv-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Action</th>
                    <th>Direction</th>
                    <th>Protocol</th>
                    <th>Port(s)</th>
                    <th>Source</th>
                    <th style={{ width: 90 }}><span className="pv-sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.proxvmRules.map((r) => (
                    <tr key={r.pos}>
                      <td className="pv-mono pv-faint">{r.pos}</td>
                      <td>
                        <span className={`pv-badge ${r.action === "ACCEPT" ? "pv-badge-ok" : "pv-badge-err"}`}>{r.action}</span>
                      </td>
                      <td>{r.type}</td>
                      <td className="pv-mono">{r.proto || "any"}</td>
                      <td className="pv-mono">{r.dport || "any"}</td>
                      <td className="pv-mono pv-faint">{r.source || ""}</td>
                      <td style={{ textAlign: "right" }}>
                        <Btn size="sm" kind="link" loading={busy === `del-${r.pos}`} onClick={() => void delRule(r.pos)}>
                          Remove
                        </Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Alert kind="info" title="Deny by default">
            Isolation drops everything not explicitly accepted below. Add rules for every protocol the
            guest should serve, then re-test the connection.
          </Alert>

          <div className="pv-grid-3" style={{ marginTop: 14 }}>
            <Field label="Action">
              {({ id }) => (
                <Select id={id} value={rule.action} onChange={(e) => setRule({ ...rule, action: e.target.value })}>
                  <option>ACCEPT</option>
                  <option>DROP</option>
                  <option>REJECT</option>
                </Select>
              )}
            </Field>
            <Field label="Direction">
              {({ id }) => (
                <Select id={id} value={rule.type} onChange={(e) => setRule({ ...rule, type: e.target.value })}>
                  <option value="in">in</option>
                  <option value="out">out</option>
                </Select>
              )}
            </Field>
            <Field label="Protocol">
              {({ id }) => (
                <Select id={id} value={rule.proto} onChange={(e) => setRule({ ...rule, proto: e.target.value })}>
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                  <option value="icmp">icmp</option>
                </Select>
              )}
            </Field>
            <Field label="Port(s)" hint="e.g. 22, or 3389-3395.">
              {({ id }) => (
                <Input id={id} placeholder="port(s)" value={rule.dport} onChange={(e) => setRule({ ...rule, dport: e.target.value })} />
              )}
            </Field>
            <Field label="Source IP/CIDR" hint="Blank = any source.">
              {({ id }) => (
                <Input id={id} placeholder="source IP/CIDR" value={rule.source} onChange={(e) => setRule({ ...rule, source: e.target.value })} />
              )}
            </Field>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <Btn loading={busy === "add"} onClick={() => void addRule()}>Add rule</Btn>
              <Btn kind="link" loading={busy === "toggle"} onClick={() => void toggle(false)}>Remove isolation</Btn>
            </div>
          </div>
        </>
      )}
    </Section>
  );
}
