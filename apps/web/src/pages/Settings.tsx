import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox } from "../components/ui.js";

const input = "w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm";
const label = "block text-xs font-medium text-slate-400 mb-1";

function Field({ label: l, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={label}>{l}</label>
      {children}
    </div>
  );
}

export default function Settings() {
  const qc = useQueryClient();
  const { data: proxmox } = useQuery({
    queryKey: ["settings-proxmox"],
    queryFn: () => api<{ configured: boolean; settings: Record<string, unknown> | null }>("/settings/proxmox"),
  });
  const { data: guacamole } = useQuery({
    queryKey: ["settings-guacamole"],
    queryFn: () => api<{ configured: boolean; settings: Record<string, unknown> | null }>("/settings/guacamole"),
  });
  const [px, setPx] = useState<Record<string, string>>({});
  const [gac, setGac] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const pxField = (key: string, def: unknown): string => px[key] ?? (def === undefined || def === null ? "" : String(def));
  const gacField = (key: string, def: unknown): string => gac[key] ?? (def === undefined || def === null ? "" : String(def));

  const saveProxmox = async () => {
    setError(null);
    try {
      await api("/settings/proxmox", {
        method: "PUT",
        body: {
          url: pxField("url", proxmox?.settings?.url ?? ""),
          tokenId: pxField("tokenId", proxmox?.settings?.tokenId ?? ""),
          tokenSecret: pxField("tokenSecret", proxmox?.settings?.tokenSecret ?? "") || "********",
          verifySsl: (pxField("verifySsl", String(proxmox?.settings?.verifySsl ?? "false")) === "true"),
          defaultNode: pxField("defaultNode", proxmox?.settings?.defaultNode ?? "") || undefined,
          defaultStorage: pxField("defaultStorage", proxmox?.settings?.defaultStorage ?? "") || undefined,
          defaultNetwork: pxField("defaultNetwork", proxmox?.settings?.defaultNetwork ?? "") || undefined,
        },
      });
      setSaved("Proxmox settings saved");
      void qc.invalidateQueries({ queryKey: ["settings-proxmox"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveGuacamole = async () => {
    setError(null);
    try {
      await api("/settings/guacamole", {
        method: "PUT",
        body: {
          dbEngine: (gacField("dbEngine", guacamole?.settings?.engine ?? "postgresql")) as "postgresql" | "mariadb" | "mysql",
          url: gacField("url", guacamole?.settings?.url ?? ""),
          publicUrl: gacField("publicUrl", guacamole?.settings?.publicUrl ?? ""),
          dbHost: gacField("dbHost", guacamole?.settings?.dbHost ?? ""),
          dbPort: Number(gacField("dbPort", String(guacamole?.settings?.dbPort ?? "5432"))),
          dbName: gacField("dbName", guacamole?.settings?.dbName ?? ""),
          dbUser: gacField("dbUser", guacamole?.settings?.dbUser ?? ""),
          dbPassword: gacField("dbPassword", guacamole?.settings?.dbPassword ?? "") || "********",
          dbSsl: gacField("dbSsl", String(guacamole?.settings?.dbSsl ?? "false")) === "true",
        },
      });
      setSaved("Guacamole settings saved");
      void qc.invalidateQueries({ queryKey: ["settings-guacamole"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const s = proxmox?.settings ?? {};
  const g = guacamole?.settings ?? {};

  return (
    <div>
      <PageTitle title="Settings" />
      {error && <ErrorBox error={error} />}
      {saved && <div className="bg-green-900/50 border border-green-700 text-green-200 rounded p-3 mb-4 text-sm">{saved}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-3">Proxmox</h2>
          <div className="space-y-3">
            <Field label="URL"><input className={input} value={pxField("url", s.url)} onChange={(e) => setPx({ ...px, url: e.target.value })} /></Field>
            <Field label="Token ID"><input className={input} value={pxField("tokenId", s.tokenId)} onChange={(e) => setPx({ ...px, tokenId: e.target.value })} /></Field>
            <Field label="Token secret (stored value shown masked)">
              <input type="password" className={input} placeholder={String(s.tokenSecret ?? "")} value={pxField("tokenSecret", "")} onChange={(e) => setPx({ ...px, tokenSecret: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={pxField("verifySsl", String(s.verifySsl ?? "false")) === "true"}
                onChange={(e) => setPx({ ...px, verifySsl: String(e.target.checked) })}
              />
              Verify SSL
            </label>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Default node"><input className={input} value={pxField("defaultNode", s.defaultNode)} onChange={(e) => setPx({ ...px, defaultNode: e.target.value })} /></Field>
              <Field label="Default storage"><input className={input} value={pxField("defaultStorage", s.defaultStorage)} onChange={(e) => setPx({ ...px, defaultStorage: e.target.value })} /></Field>
              <Field label="Default bridge"><input className={input} value={pxField("defaultNetwork", s.defaultNetwork)} onChange={(e) => setPx({ ...px, defaultNetwork: e.target.value })} /></Field>
            </div>
            <button onClick={saveProxmox} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm">Save</button>
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-3">Guacamole</h2>
          <div className="space-y-3">
            <Field label="Database engine">
              <select
                className={input}
                value={gacField("dbEngine", g.engine ?? "postgresql")}
                onChange={(e) => setGac({ ...gac, dbEngine: e.target.value })}
              >
                <option value="mariadb">MariaDB</option>
                <option value="mysql">MySQL</option>
                <option value="postgresql">PostgreSQL</option>
              </select>
            </Field>
            <Field label="URL"><input className={input} value={gacField("url", g.url)} onChange={(e) => setGac({ ...gac, url: e.target.value })} /></Field>
            <Field label="Public URL (for browser, e.g. https://guacamole.example.com/guacamole/)">
              <input className={input} value={gacField("publicUrl", g.publicUrl ?? "")} onChange={(e) => setGac({ ...gac, publicUrl: e.target.value })} placeholder="Leave empty to use the URL above" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="DB host"><input className={input} value={gacField("dbHost", g.dbHost)} onChange={(e) => setGac({ ...gac, dbHost: e.target.value })} /></Field>
              <Field label="DB port"><input type="number" className={input} value={gacField("dbPort", String(g.dbPort ?? ""))} onChange={(e) => setGac({ ...gac, dbPort: e.target.value })} /></Field>
            </div>
            <Field label="DB name"><input className={input} value={gacField("dbName", g.dbName)} onChange={(e) => setGac({ ...gac, dbName: e.target.value })} /></Field>
            <Field label="DB user"><input className={input} value={gacField("dbUser", g.dbUser)} onChange={(e) => setGac({ ...gac, dbUser: e.target.value })} /></Field>
            <Field label="DB password (stored value masked)">
              <input type="password" className={input} placeholder={String(g.dbPassword ?? "")} value={gacField("dbPassword", "")} onChange={(e) => setGac({ ...gac, dbPassword: e.target.value })} />
            </Field>
            <button onClick={saveGuacamole} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm">Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}