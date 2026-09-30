import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox } from "../components/ui.js";

interface DomainConfig {
  canonical: string | null;
  aliases: string[];
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

const input = "w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm";
const label = "block text-xs font-medium text-slate-400 mb-1";
const btn = "px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded";

export default function Domains() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [switchName, setSwitchName] = useState("");
  const [search, setSearch] = useState("");
  const [serviceInput, setServiceInput] = useState("");
  const [aliasInput, setAliasInput] = useState("");

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

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["domains-config"] });
    void qc.invalidateQueries({ queryKey: ["domains-cf-test"] });
    void qc.invalidateQueries({ queryKey: ["domains-dns"] });
    void qc.invalidateQueries({ queryKey: ["domains-tunnel-test"] });
  };

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

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
          ? `Boom — now serving ${res.canonical} (${res.record.name} → ${res.record.content}). DNS + HTTPS verified; old URLs redirect automatically.${tunneled}`
          : `⚠️ Switched to ${res.canonical} (${res.record.name} → ${res.record.content}), BUT: ${res.verification.detail}.${tunneled} Finish TLS/proxy setup, then open the new domain and confirm login before retiring the old one.`,
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
    <div className="max-w-3xl">
      <PageTitle title="Domains" />
      {error && <ErrorBox error={error} />}
      {status && <div className="bg-green-900/50 border border-green-700 text-green-200 rounded p-3 mb-4 text-sm">{status}</div>}

      <div className="bg-slate-900 border border-slate-800 rounded p-5 mb-4">
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-slate-400 w-36">API key</span>
            {!config?.cloudflare.zoneId ? (
              <span className="text-slate-500">not wired — set server env (see .env.example)</span>
            ) : cfTesting ? (
              <span className="text-slate-400">checking…</span>
            ) : keyOk ? (
              <span className="text-green-300">✓ works{cfTest?.zone ? ` (zone ${cfTest.zone.name})` : ""}</span>
            ) : (
              <span className="text-red-300">✗ not working — check the token and Zone ID below</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-400 w-36">Current domain</span>
            <span className="font-mono text-blue-300">{config?.canonical ?? "(none set yet)"}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-400 w-36">Tunnel ingress</span>
            {!config?.cloudflare.accountId || !config?.cloudflare.tunnelId ? (
              <span className="text-slate-500">manual — save an Account + Tunnel ID below for full-auto</span>
            ) : tunnelTesting ? (
              <span className="text-slate-400">checking…</span>
            ) : tunnel?.managed ? (
              <span className="text-green-300">
                ✓ auto{tunnel.canonicalService ? ` (current → ${tunnel.canonicalService})` : ""} ·{" "}
                {tunnel.hostnames.length} hostname{tunnel.hostnames.length === 1 ? "" : "s"} routed
              </span>
            ) : (
              <span className="text-amber-300">local config.yml — convert to cloud-managed once, or route by hand</span>
            )}
          </div>
          <div className="flex items-start gap-2">
            <span className="text-slate-400 w-36">Redirecting</span>
            <span className="font-mono text-slate-300">
              {(config?.aliases ?? []).length > 0 ? config!.aliases.join(", ") : "(none — old URLs serve normally)"}
            </span>
          </div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded p-5 mb-4">
        <h2 className="text-sm font-medium text-slate-300 mb-3">Switch domain</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            className={input}
            placeholder="proxvm3"
            value={switchName}
            onChange={(e) => setSwitchName(e.target.value)}
          />
          <select
            className={input}
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
            value={targetInput}
            onChange={(e) => { setTargetInput(e.target.value); setCopyFrom(""); }}
          />
          <select className={input} value={recordType} onChange={(e) => setRecordType(e.target.value)}>
            <option value="">Type: auto</option>
            <option value="A">A (IPv4)</option>
            <option value="AAAA">AAAA (IPv6)</option>
            <option value="CNAME">CNAME (hostname)</option>
          </select>
          <input
            className={input}
            placeholder="Tunnel service target (blank = copy current rule)"
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
          <div className="text-xs text-slate-500 mt-2 space-y-0.5">
            <div className="font-medium text-slate-400">Existing tunnel routes (pick a service from here):</div>
            {tunnel!.routes.map((r) => (
              <div key={r.hostname} className="font-mono">
                {r.hostname} → {r.service}
              </div>
            ))}
          </div>
        )}
        {needsTarget && (
          <div className="text-xs text-slate-500 mt-2">
            No current domain set yet — pick “copy from” above (easiest) or type the public target by hand.
            Never a URL, never a 192.168.x LAN address.
          </div>
        )}
        <button onClick={doSwitch} disabled={!switchName.trim() || !keyOk || (needsTarget && !targetInput.trim())} className={`${btn} mt-3`}>
          Switch
        </button>
        {!keyOk && <div className="text-xs text-slate-500 mt-2">Cloudflare isn't wired — set the server env vars (see .env.example).</div>}
      </div>

      <details className="bg-slate-900 border border-slate-800 rounded p-5 mb-4 text-sm">
        <summary className="cursor-pointer text-slate-300 font-medium">DNS records</summary>
        <div className="space-y-3 mt-3">
          <div>
            <label className={label}>DNS records (A / AAAA / CNAME)</label>
            <input className={`${input} mb-2`} placeholder="Filter…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {(dns?.records ?? []).map((r) => (
                <div key={r.id} className="flex flex-wrap gap-2 items-center text-xs py-1 border-b border-slate-800/50">
                  <span className="font-mono text-slate-500 w-14">{r.type}</span>
                  <span className="font-mono text-slate-200">{r.name}</span>
                  <span className="font-mono text-slate-500">→ {r.content}</span>
                  {r.proxied && <span className="text-amber-300">☁</span>}
                  {config?.canonical && r.name.toLowerCase() === config.canonical && (
                    <span className="text-green-300">● current</span>
                  )}
                  {(config?.aliases ?? []).includes(r.name.toLowerCase()) && (
                    <span className="text-blue-300">↪ redirect</span>
                  )}
                </div>
              ))}
              {config?.cloudflare.zoneId && !(dns?.records ?? []).length && <div className="text-xs text-slate-500">No records match.</div>}
              {!config?.cloudflare.zoneId && <div className="text-xs text-slate-500">No Zone ID wired on the server — see .env.example.</div>}
            </div>
          </div>
          <div>
            <label className={label}>Redirect an old hostname here (visitors bounce to the current domain)</label>
            <div className="flex gap-2">
              <input
                className={input}
                placeholder="proxvm2.benmoyer.org"
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
              />
              <button onClick={addAlias} disabled={!aliasInput.trim()} className={btn}>Add</button>
            </div>
          </div>
          {(config?.aliases ?? []).length > 0 && (
            <div>
              <label className={label}>Stop redirecting (old URLs will die)</label>
              <div className="space-y-1">
                {(config?.aliases ?? []).map((a) => (
                  <div key={a} className="flex justify-between text-sm py-0.5">
                    <span className="font-mono text-slate-300">{a}</span>
                    <button className="text-xs text-red-300 underline" onClick={() => void removeAlias(a)}>Remove</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
