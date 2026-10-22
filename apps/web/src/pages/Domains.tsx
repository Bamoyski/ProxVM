import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageHeader, Section, EmptyState, Btn, Alert, Field, errText } from "../ui/index.js";

interface DomainConfig {
  canonical: string | null;
  aliases: string[];
  autoRotate?: boolean;
  cloudflare: { configured: boolean; zoneId: string | null; accountId: string | null; tunnelId: string | null };
}

interface TunnelStatus {
  ok: boolean;
  managed: boolean;
  hostnames: string[];
  routes: Array<{ hostname: string; service: string }>;
  canonicalService: string | null;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

const input = "pv-input";
const label = "pv-label";

export default function Domains() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [switchName, setSwitchName] = useState("");
  const [search, setSearch] = useState("");
  const [serviceInput, setServiceInput] = useState("");
  const [aliasInput, setAliasInput] = useState("");
  const [securlyEmail, setSecurlyEmail] = useState("");

  const { data: config } = useQuery({
    queryKey: ["domains-config"],
    queryFn: () => api<DomainConfig>("/domains/config"),
  });
  // Confirm the key works as soon as the page loads (no click needed).
  const { data: cfTest, isFetching: cfTesting } = useQuery({
    queryKey: ["domains-cf-test"],
    queryFn: () => api<{ ok: boolean; zone: { name: string; status: string } }>("/domains/cloudflare/test", { method: "POST" }),
    enabled: !!config?.cloudflare.zoneId,
    retry: false,
    staleTime: 60000,
  });
  const { data: dns } = useQuery({
    queryKey: ["domains-dns", search],
    queryFn: () => api<{ records: DnsRecord[] }>(`/domains/dns${search ? `?search=${encodeURIComponent(search)}` : ""}`),
    enabled: !!config?.cloudflare.zoneId,
  });
  // Tunnel status (auto-ingress): only queried once an account + tunnel are saved.
  const { data: tunnel, isFetching: tunnelTesting } = useQuery({
    queryKey: ["domains-tunnel-test"],
    queryFn: () => api<TunnelStatus>("/domains/tunnels/test", { method: "POST" }),
    enabled: !!config?.cloudflare.accountId && !!config?.cloudflare.tunnelId,
    retry: false,
    staleTime: 60000,
  });

  const { data: filter } = useQuery({
    queryKey: ["domains-filter-check"],
    queryFn: () =>
      api<{ status: string; hostname: string | null; ruleId: string | null; detail: string }>("/domains/filter-check"),
    retry: false,
    staleTime: 60000,
  });

  const saveSecurly = async () => {
    setError(null);
    setStatus(null);
    try {
      await api("/domains/securly", { method: "PUT", body: { useremail: securlyEmail } });
      setSecurlyEmail("");
      setStatus("School-filter watch saved. Status re-checks automatically.");
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const toggleAutoRotate = async () => {
    setError(null);
    setStatus(null);
    const enabled = !(config?.autoRotate ?? false);
    try {
      await api("/domains/auto-rotate", { method: "PUT", body: { enabled } });
      setStatus(
        enabled
          ? "Auto-rotate on. When the school filter blocks the current domain, the next numbered domain is switched to automatically (proxvm6 → proxvm7, max 5/day, you get an alert each move)."
          : "Auto-rotate off. Blocked domains now need a manual Switch.",
      );
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["domains-config"] });
    void qc.invalidateQueries({ queryKey: ["domains-cf-test"] });
    void qc.invalidateQueries({ queryKey: ["domains-dns"] });
    void qc.invalidateQueries({ queryKey: ["domains-tunnel-test"] });
    void qc.invalidateQueries({ queryKey: ["domains-filter-check"] });
  };

  const fail = (err: unknown) => setError(errText(err));

  const applyCopyFrom = (id: string): void => {
    setCopyFrom(id);
    const rec = (dns?.records ?? []).find((r) => r.id === id);
    if (rec) {
      setTargetInput(rec.content);
      setRecordType(rec.type);
    }
  };

  const doSwitch = async () => {
    setError(null);
    setStatus(null);
    try {
      const res = await api<{
        record: DnsRecord;
        canonical: string;
        aliases: string[];
        tunnel: { managed: boolean; ruleEnsured: boolean; service: string | null };
        verification: { dnsOk: boolean; httpsOk: boolean; detail: string };
      }>("/domains/switch", {
        method: "POST",
        body: {
          name: switchName,
          target: targetInput.trim() || undefined,
          recordType: (recordType || undefined) as "A" | "AAAA" | "CNAME" | undefined,
          copyFrom: copyFrom || undefined,
          service: serviceInput.trim() || undefined,
        },
      });
      setSwitchName("");
      setTargetInput("");
      setCopyFrom("");
      setRecordType("");
      setServiceInput("");
      const verified = res.verification.dnsOk && res.verification.httpsOk;
      const tunneled = res.tunnel.managed ? ` Tunnel route ensured (${res.tunnel.service}).` : "";
      setStatus(
        verified
          ? `Now serving ${res.canonical} (${res.record.name} → ${res.record.content}). DNS + HTTPS verified; old URLs redirect automatically.${tunneled}`
          : `Switched to ${res.canonical} (${res.record.name} → ${res.record.content}), but verification is incomplete: ${res.verification.detail}.${tunneled} Finish TLS/proxy setup, then open the new domain and confirm login before retiring the old one.`,
      );
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const addAlias = async () => {
    setError(null);
    setStatus(null);
    try {
      const res = await api<{ canonical: string | null; aliases: string[] }>("/domains/aliases", {
        method: "POST",
        body: { host: aliasInput.trim() },
      });
      setAliasInput("");
      setStatus(`Done — ${aliasInput.trim()} now redirects to ${res.canonical ?? "the current domain"}.`);
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const removeAlias = async (host: string) => {
    setError(null);
    try {
      await api(`/domains/aliases/${encodeURIComponent(host)}`, { method: "DELETE" });
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const keyOk = cfTest?.ok === true;
  // First switch ever: nothing to copy the target from, so require it.
  const needsTarget = !config?.canonical;
  const [targetInput, setTargetInput] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const [recordType, setRecordType] = useState("");

  return (
    <div className="pv-page pv-page-narrow">
      <PageHeader title="Domains" description="Canonical hostname, DNS, tunnel ingress, and filter watch." />
      {error && <Alert kind="err" title="Action failed">{error}</Alert>}
      {status && <Alert kind="ok" title="Done">{status}</Alert>}

      <Section title="Status">
        <dl className="pv-kv">
          <dt>API key</dt>
          <dd>
            {!config?.cloudflare.zoneId ? (
              <span style={{ color: "var(--pv-text-3)" }}>not wired — set server env (see .env.example)</span>
            ) : cfTesting ? (
              <span style={{ color: "var(--pv-text-3)" }}>checking…</span>
            ) : keyOk ? (
              <span className="pv-status pv-status-ok">works{cfTest?.zone ? ` (zone ${cfTest.zone.name})` : ""}</span>
            ) : (
              <span className="pv-status pv-status-err">not working — check the token and Zone ID</span>
            )}
          </dd>
          <dt>Current domain</dt>
          <dd><span className="pv-mono">{config?.canonical ?? "(none set yet)"}</span></dd>
          <dt>Tunnel ingress</dt>
          <dd>
            {!config?.cloudflare.accountId || !config?.cloudflare.tunnelId ? (
              <span style={{ color: "var(--pv-text-3)" }}>manual — save an Account + Tunnel ID below for full-auto</span>
            ) : tunnelTesting ? (
              <span style={{ color: "var(--pv-text-3)" }}>checking…</span>
            ) : tunnel?.managed ? (
              <span className="pv-status pv-status-ok">
                auto{tunnel.canonicalService ? ` (current → ${tunnel.canonicalService})` : ""} ·{" "}
                {tunnel.hostnames.length} hostname{tunnel.hostnames.length === 1 ? "" : "s"} routed
              </span>
            ) : (
              <span className="pv-status pv-status-warn">local config.yml — convert to cloud-managed once, or route by hand</span>
            )}
          </dd>
          <dt>School filter</dt>
          <dd>
            {!filter ? (
              <span style={{ color: "var(--pv-text-3)" }}>checking…</span>
            ) : filter.status === "blocked" ? (
              <span className="pv-status pv-status-err">
                blocked{filter.ruleId ? ` (rule ${filter.ruleId})` : ""} — {filter.hostname}: {filter.detail}
              </span>
            ) : filter.status === "clean" ? (
              <span className="pv-status pv-status-ok">reachable — {filter.hostname}: {filter.detail}</span>
            ) : (
              <span style={{ color: "var(--pv-text-3)" }}>{filter.detail}</span>
            )}
          </dd>
          <dt>Auto-rotate on block</dt>
          <dd>
            {config ? (
              <span style={{ display: "inline-flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <Btn size="sm" kind={config.autoRotate ? "danger-ghost" : "primary"} onClick={toggleAutoRotate}>
                  {config.autoRotate ? "Turn off" : "Turn on"}
                </Btn>
                <span
                  className={config.autoRotate ? "pv-status pv-status-ok" : ""}
                  style={{ color: config.autoRotate ? undefined : "var(--pv-text-3)" }}
                >
                  {config.autoRotate
                    ? "on — a blocked domain auto-bumps to the next number (proxvm6 → proxvm7), verified, then flipped; max 5/day"
                    : "off — a blocked domain needs a manual Switch"}
                </span>
              </span>
            ) : (
              <span style={{ color: "var(--pv-text-3)" }}>checking…</span>
            )}
          </dd>
          <dt>Redirecting</dt>
          <dd>
            <span className="pv-mono">
              {(config?.aliases ?? []).length > 0 ? config!.aliases.join(", ") : "(none — old URLs serve normally)"}
            </span>
          </dd>
        </dl>
      </Section>

      <Section title="Switch domain">
        <div className="pv-grid-2" style={{ marginBottom: 8 }}>
          <input
            className={input}
            placeholder="proxvm3"
            aria-label="New canonical hostname"
            value={switchName}
            onChange={(e) => setSwitchName(e.target.value)}
          />
          <select
            className="pv-select"
            aria-label="Copy settings from an existing record"
            value={copyFrom}
            onChange={(e) => applyCopyFrom(e.target.value)}
          >
            <option value="">Copy settings from… (recommended)</option>
            {(dns?.records ?? []).map((r) => (
              <option key={r.id} value={r.id}>{r.name} ({r.type} → {r.content})</option>
            ))}
          </select>
          <input
            className={input}
            placeholder={needsTarget ? "Target IP/hostname (required first time)" : "Target (blank = copy current)"}
            aria-label="Public target IP or hostname"
            value={targetInput}
            onChange={(e) => { setTargetInput(e.target.value); setCopyFrom(""); }}
          />
          <select className="pv-select" aria-label="DNS record type" value={recordType} onChange={(e) => setRecordType(e.target.value)}>
            <option value="">Type: auto</option>
            <option value="A">A (IPv4)</option>
            <option value="AAAA">AAAA (IPv6)</option>
            <option value="CNAME">CNAME (hostname)</option>
          </select>
          <input
            className={input}
            placeholder="Tunnel service target (blank = copy current rule)"
            aria-label="Tunnel service target"
            value={serviceInput}
            onChange={(e) => setServiceInput(e.target.value)}
            list="tunnel-service-options"
          />
          <datalist id="tunnel-service-options">
            {[...new Set((tunnel?.routes ?? []).map((r) => r.service))].map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        {(tunnel?.routes ?? []).length > 0 && (
          <div style={{ fontSize: "0.78rem", color: "var(--pv-text-2)", marginBottom: 8 }}>
            <div className="pv-label">Existing tunnel routes (pick a service from here)</div>
            {tunnel!.routes.map((r) => (
              <div key={r.hostname} className="pv-mono">
                {r.hostname} → {r.service}
              </div>
            ))}
          </div>
        )}
        {needsTarget && (
          <div className="pv-hint" style={{ marginBottom: 8 }}>
            No current domain set yet — pick “copy from” above (easiest) or type the public target by hand.
            Never a URL, never a 192.168.x LAN address.
          </div>
        )}
        <Btn kind="primary" onClick={doSwitch} disabled={!switchName.trim() || !keyOk || (needsTarget && !targetInput.trim())}>
          Switch
        </Btn>
        {!keyOk && <div className="pv-hint" style={{ marginTop: 8 }}>Cloudflare isn't wired — set the server env vars (see .env.example).</div>}
      </Section>

      <Section title="DNS records">
        <Field label="Filter (A / AAAA / CNAME)">
          <input className={input} placeholder="Filter…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
        <div style={{ maxHeight: 288, overflowY: "auto", marginBottom: 16 }}>
          {(dns?.records ?? []).map((r) => (
            <div key={r.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: "0.78rem", padding: "5px 0", borderBottom: "1px solid var(--pv-border-soft)" }}>
              <span className="pv-mono" style={{ color: "var(--pv-text-3)", width: 56 }}>{r.type}</span>
              <span className="pv-mono">{r.name}</span>
              <span className="pv-mono" style={{ color: "var(--pv-text-3)" }}>→ {r.content}</span>
              {r.proxied && <span className="pv-mono" title="Proxied through Cloudflare" style={{ color: "var(--pv-warn)" }}>proxied</span>}
              {config?.canonical && r.name.toLowerCase() === config.canonical && (
                <span className="pv-status pv-status-ok">current</span>
              )}
              {(config?.aliases ?? []).includes(r.name.toLowerCase()) && (
                <span className="pv-status pv-status-info">redirect</span>
              )}
            </div>
          ))}
          {config?.cloudflare.zoneId && !(dns?.records ?? []).length && <EmptyState title="No records match" />}
          {!config?.cloudflare.zoneId && <EmptyState title="No Zone ID wired" body="See .env.example on the server." />}
        </div>
        <Field label="School user email" hint="Filter-watch oracle scope — a student address from the filtered school.">
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className={input}
              placeholder="student@students.example.org"
              value={securlyEmail}
              onChange={(e) => setSecurlyEmail(e.target.value)}
            />
            <Btn kind="primary" onClick={saveSecurly}>Save</Btn>
          </div>
        </Field>
        <Field label="Redirect an old hostname here">
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className={input}
              placeholder="proxvm4.example.org"
              value={aliasInput}
              onChange={(e) => setAliasInput(e.target.value)}
            />
            <Btn kind="primary" onClick={addAlias} disabled={!aliasInput.trim()}>Add</Btn>
          </div>
        </Field>
        {(config?.aliases ?? []).length > 0 && (
          <div className="pv-field">
            <span className="pv-label">Stop redirecting (old URLs will die)</span>
            {(config?.aliases ?? []).map((a) => (
              <div key={a} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "0.85rem" }}>
                <span className="pv-mono">{a}</span>
                <Btn size="sm" kind="link" onClick={() => void removeAlias(a)}>Remove</Btn>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
