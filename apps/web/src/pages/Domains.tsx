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
  const [switchName, setSwitchName] = useState("");
  const [search, setSearch] = useState("");

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

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["domains-config"] });
    void qc.invalidateQueries({ queryKey: ["domains-cf-test"] });
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
      setStatus("Saved. Key status re-checks automatically.");
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
        body: { name: switchName },
      });
      setSwitchName("");
      setStatus(`Boom — now serving ${res.canonical} (${res.record.name} → ${res.record.content}). Old URLs redirect automatically.`);
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
              <span className="text-slate-500">not connected — expand setup below</span>
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
          {(config?.aliases ?? []).length > 0 && (
            <div className="flex items-start gap-2">
              <span className="text-slate-400 w-36">Redirecting</span>
              <span className="font-mono text-slate-300">{config?.aliases.join(", ")}</span>
            </div>
          )}
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded p-5 mb-4">
        <h2 className="text-sm font-medium text-slate-300 mb-3">Switch domain</h2>
        <div className="flex gap-2">
          <input
            className={input}
            placeholder="proxvm2 (target auto-copied from current)"
            value={switchName}
            onChange={(e) => setSwitchName(e.target.value)}
          />
          <button onClick={doSwitch} disabled={!switchName.trim() || !keyOk} className={btn}>
            Switch
          </button>
        </div>
        {!keyOk && <div className="text-xs text-slate-500 mt-2">Connect Cloudflare below first.</div>}
      </div>

      <details className="bg-slate-900 border border-slate-800 rounded p-5 mb-4 text-sm">
        <summary className="cursor-pointer text-slate-300 font-medium">Cloudflare connection & DNS records</summary>
        <div className="space-y-3 mt-3">
          <div>
            <label className={label}>API token (stored encrypted, leave blank to keep)</label>
            <input type="password" className={input} value={cf.apiToken} onChange={(e) => setCf({ ...cf, apiToken: e.target.value })} />
          </div>
          <div>
            <label className={label}>Zone ID</label>
            <input className={input} value={cf.zoneId} onChange={(e) => setCf({ ...cf, zoneId: e.target.value })} placeholder={config?.cloudflare.zoneId ?? ""} />
          </div>
          <button onClick={saveCf} className={btn}>Save</button>
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
              {!config?.cloudflare.zoneId && <div className="text-xs text-slate-500">Save a Zone ID to list records.</div>}
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
