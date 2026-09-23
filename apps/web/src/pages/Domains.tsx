import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox } from "../components/ui.js";

interface DomainConfig {
  canonical: string | null;
  aliases: string[];
  cloudflare: { configured: boolean; zoneId: string | null };
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
  const [cf, setCf] = useState({ apiToken: "", zoneId: "" });
  const [canonicalInput, setCanonicalInput] = useState("");
  const [switchForm, setSwitchForm] = useState({ name: "", target: "", proxied: true });
  const [search, setSearch] = useState("");

  const { data: config } = useQuery({
    queryKey: ["domains-config"],
    queryFn: () => api<DomainConfig>("/domains/config"),
  });
  const { data: dns } = useQuery({
    queryKey: ["domains-dns", search],
    queryFn: () => api<{ records: DnsRecord[] }>(`/domains/dns${search ? `?search=${encodeURIComponent(search)}` : ""}`),
    enabled: !!config?.cloudflare.zoneId,
  });

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["domains-config"] });
    void qc.invalidateQueries({ queryKey: ["domains-dns"] });
  };

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const saveCf = async () => {
    setError(null);
    setStatus(null);
    try {
      await api("/domains/cloudflare", {
        method: "PUT",
        body: { apiToken: cf.apiToken || undefined, zoneId: cf.zoneId || undefined },
      });
      setCf({ apiToken: "", zoneId: "" });
      setStatus("Cloudflare connection saved. The token is stored encrypted and never shown again.");
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const testCf = async () => {
    setError(null);
    setStatus(null);
    try {
      const res = await api<{ ok: boolean; zone: { name: string; status: string } }>("/domains/cloudflare/test", { method: "POST" });
      setStatus(`Cloudflare OK — zone ${res.zone.name} (${res.zone.status}).`);
    } catch (err) {
      fail(err);
    }
  };

  const setCanonical = async () => {
    setError(null);
    setStatus(null);
    try {
      const res = await api<DomainConfig>("/domains/config", { method: "PUT", body: { canonical: canonicalInput } });
      setCanonicalInput("");
      setStatus(`Canonical domain is now ${res.canonical}. The previous domain keeps working via redirect.`);
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

  const doSwitch = async () => {
    setError(null);
    setStatus(null);
    try {
      const res = await api<{ record: DnsRecord; canonical: string; aliases: string[] }>("/domains/switch", {
        method: "POST",
        body: { name: switchForm.name, target: switchForm.target || undefined, proxied: switchForm.proxied },
      });
      setSwitchForm({ name: "", target: "", proxied: true });
      setStatus(`DNS updated (${res.record.name} → ${res.record.content}) and canonical domain is now ${res.canonical}. Old URLs redirect automatically.`);
      reload();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <div>
      <PageTitle title="Domains & Cloudflare" />
      {error && <ErrorBox error={error} />}
      {status && <div className="bg-green-900/50 border border-green-700 text-green-200 rounded p-3 mb-4 text-sm">{status}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded p-4">
            <h2 className="text-sm font-medium text-slate-300 mb-1">Canonical domain & redirects</h2>
            <p className="text-xs text-slate-500 mb-3">
              Current: <span className="font-mono text-blue-300">{config?.canonical ?? "(none set)"}</span>. Old
              domains stay listed below and automatically redirect here — never delete their DNS records.
            </p>
            <div className="flex gap-2 mb-3">
              <input
                className={input}
                placeholder="app.example.com"
                value={canonicalInput}
                onChange={(e) => setCanonicalInput(e.target.value)}
              />
              <button onClick={setCanonical} disabled={!canonicalInput.trim()} className={btn}>Set</button>
            </div>
            <div className="space-y-1">
              {(config?.aliases ?? []).map((a) => (
                <div key={a} className="flex justify-between text-sm py-0.5">
                  <span className="font-mono text-slate-300">{a} <span className="text-xs text-slate-500">→ redirects</span></span>
                  <button className="text-xs text-red-300 underline" onClick={() => void removeAlias(a)}>Remove</button>
                </div>
              ))}
              {!(config?.aliases ?? []).length && <div className="text-xs text-slate-500">No redirect aliases.</div>}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded p-4">
            <h2 className="text-sm font-medium text-slate-300 mb-1">Cloudflare connection</h2>
            <p className="text-xs text-slate-500 mb-3">
              Needs an API token with DNS edit permission and the Zone ID (both on the zone's Cloudflare dashboard).
              Status: {config?.cloudflare.configured ? <span className="text-green-300">token saved</span> : <span className="text-slate-400">no token</span>}
              {config?.cloudflare.zoneId ? <span className="text-slate-400"> · zone <span className="font-mono">{config.cloudflare.zoneId}</span></span> : null}
            </p>
            <div className="space-y-3">
              <div>
                <label className={label}>API token (stored encrypted, leave blank to keep)</label>
                <input type="password" className={input} value={cf.apiToken} onChange={(e) => setCf({ ...cf, apiToken: e.target.value })} />
              </div>
              <div>
                <label className={label}>Zone ID</label>
                <input className={input} value={cf.zoneId} onChange={(e) => setCf({ ...cf, zoneId: e.target.value })} placeholder={config?.cloudflare.zoneId ?? ""} />
              </div>
              <div className="flex gap-2">
                <button onClick={saveCf} className={btn}>Save</button>
                <button onClick={testCf} className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded">Test</button>
              </div>
            </div>
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-1">Switch domain</h2>
          <p className="text-xs text-slate-500 mb-3">
            Point a name at the same target as the current domain, then flip canonical in one step.
            The old DNS record is kept so old URLs redirect instead of dying.
          </p>
          {!config?.cloudflare.zoneId ? (
            <div className="text-xs text-slate-500">Save a Zone ID first to manage DNS records.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div>
                  <label className={label}>New name (short or full)</label>
                  <input className={input} placeholder="proxvm1" value={switchForm.name} onChange={(e) => setSwitchForm({ ...switchForm, name: e.target.value })} />
                </div>
                <div>
                  <label className={label}>Target (blank = copy current)</label>
                  <input className={input} placeholder="203.0.113.10" value={switchForm.target} onChange={(e) => setSwitchForm({ ...switchForm, target: e.target.value })} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-400 mb-3">
                <input type="checkbox" checked={switchForm.proxied} onChange={(e) => setSwitchForm({ ...switchForm, proxied: e.target.checked })} />
                Proxied through Cloudflare (orange cloud)
              </label>
              <button onClick={doSwitch} disabled={!switchForm.name.trim()} className={`${btn} mb-4`}>Switch domain</button>
              <div>
                <label className={label}>DNS records (A / AAAA / CNAME)</label>
                <input className={`${input} mb-2`} placeholder="Filter…" value={search} onChange={(e) => setSearch(e.target.value)} />
                <div className="space-y-1 max-h-96 overflow-y-auto">
                  {(dns?.records ?? []).map((r) => (
                    <div key={r.id} className="flex flex-wrap gap-2 items-center text-xs py-1 border-b border-slate-800/50">
                      <span className="font-mono text-slate-500 w-14">{r.type}</span>
                      <span className="font-mono text-slate-200">{r.name}</span>
                      <span className="font-mono text-slate-500">→ {r.content}</span>
                      {r.proxied && <span className="text-amber-300">☁ proxied</span>}
                      {config?.canonical && r.name.toLowerCase() === config.canonical && (
                        <span className="text-green-300">● canonical</span>
                      )}
                      {(config?.aliases ?? []).includes(r.name.toLowerCase()) && (
                        <span className="text-blue-300">↪ redirect</span>
                      )}
                    </div>
                  ))}
                  {!(dns?.records ?? []).length && <div className="text-xs text-slate-500">No records match.</div>}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
