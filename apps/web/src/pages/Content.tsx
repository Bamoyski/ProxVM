import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox } from "../components/ui.js";

const FIELDS = [
  { key: "contact.email", label: "Contact email", kind: "text" as const, hint: "Shown on the Contact page with a mailto link." },
  { key: "contact.github", label: "GitHub profile URL", kind: "text" as const, hint: "Must start with https://." },
  { key: "contact.repo", label: "Project repo URL", kind: "text" as const, hint: "Must start with https://." },
  { key: "donate.intro", label: "Donate intro paragraph", kind: "area" as const, hint: "Plain text, shown at the top of Donate." },
  { key: "donate.funfact", label: "Donate fun-fact paragraph", kind: "area" as const, hint: "Plain text, below the intro." },
  {
    key: "donate.tiers",
    label: "Donate tiers (JSON)",
    kind: "area" as const,
    hint: 'JSON array like [{"amount":"$3","blurb":"..."}] — max 12 entries. Invalid JSON falls back to built-ins.',
  },
];

const input = "w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm";
const label = "block text-xs font-medium text-slate-400 mb-1";

export default function Content() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const { data } = useQuery({
    queryKey: ["site-content-admin"],
    queryFn: () => api<{ entries: Record<string, string> }>("/content"),
  });
  const server = data?.entries ?? {};
  const shown = (key: string): string => (touched[key] ? (values[key] ?? "") : (server[key] ?? ""));

  const save = async () => {
    setError(null);
    setStatus(null);
    try {
      const entries: Record<string, string> = {};
      for (const f of FIELDS) {
        if (touched[f.key]) entries[f.key] = (values[f.key] ?? "").trim();
      }
      if (Object.keys(entries).length === 0) {
        setStatus("Nothing changed.");
        return;
      }
      await api("/content", { method: "PUT", body: { entries } });
      setTouched({});
      setStatus("Saved. Pages pick it up within minutes (cached briefly per browser). Empty fields reset to built-ins.");
      void qc.invalidateQueries({ queryKey: ["site-content-admin"] });
      void qc.invalidateQueries({ queryKey: ["site-content"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="max-w-3xl">
      <PageTitle title="Site content" />
      {error && <ErrorBox error={error} />}
      {status && <div className="bg-green-900/50 border border-green-700 text-green-200 rounded p-3 mb-4 text-sm">{status}</div>}
      <p className="text-xs text-slate-500 mb-4">
        Edit the site's text without deploying. Clearing a field restores its built-in default.
        A blue dot marks fields you have customized.
      </p>
      <div className="space-y-4">
        {FIELDS.map((f) => (
          <div key={f.key} className="bg-slate-900 border border-slate-800 rounded p-4">
            <label className={label}>
              {f.label} {server[f.key] !== undefined && <span className="text-blue-400">●</span>}
            </label>
            {f.kind === "text" ? (
              <input
                className={input}
                value={shown(f.key)}
                placeholder="(built-in default)"
                onChange={(e) => {
                  setValues({ ...values, [f.key]: e.target.value });
                  setTouched({ ...touched, [f.key]: true });
                }}
              />
            ) : (
              <textarea
                className={input}
                rows={f.key === "donate.tiers" ? 6 : 3}
                value={shown(f.key)}
                placeholder="(built-in default)"
                onChange={(e) => {
                  setValues({ ...values, [f.key]: e.target.value });
                  setTouched({ ...touched, [f.key]: true });
                }}
              />
            )}
            <div className="text-xs text-slate-500 mt-1 font-mono">{f.key} · {f.hint}</div>
          </div>
        ))}
        <button onClick={() => void save()} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 rounded">
          Save content
        </button>
      </div>
    </div>
  );
}
