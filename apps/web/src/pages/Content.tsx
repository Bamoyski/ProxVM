import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import {
  PageHeader, Section, Btn, Field, Input, Textarea, Alert, useToast, errText,
} from "../ui/index.js";

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

/** Admin editor for the site's static text (contact + donate pages). */
export default function Content() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const { data } = useQuery({
    queryKey: ["site-content-admin"],
    queryFn: () => api<{ entries: Record<string, string> }>("/content"),
  });
  const server = data?.entries ?? {};
  const shown = (key: string): string => (touched[key] ? (values[key] ?? "") : (server[key] ?? ""));

  const save = async () => {
    if (saving) return;
    setStatus(null);
    setSaving(true);
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
      toast.err("Save failed", errText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pv-page pv-page-narrow">
      <PageHeader
        title="Site content"
        description="Edit the site's text without deploying. Clearing a field restores its built-in default."
        actions={
          <Btn kind="primary" loading={saving} onClick={() => void save()}>
            Save content
          </Btn>
        }
      />
      {status && status !== "Nothing changed." && <Alert kind="ok" title="Saved">{status}</Alert>}
      {status === "Nothing changed." && <Alert kind="info" title="Nothing changed" />}

      <Section title="Fields" hint="A dot marks fields you have customized.">
        {FIELDS.map((f) => (
          <Field
            key={f.key}
            label={
              <span>
                {f.label}{" "}
                {server[f.key] !== undefined && (
                  <span style={{ color: "var(--pv-accent)" }} title="Customized — clearing the field resets it">
                    ●
                  </span>
                )}
              </span>
            }
            hint={`${f.key} · ${f.hint}`}
          >
            {({ id }) =>
              f.kind === "text" ? (
                <Input
                  id={id}
                  value={shown(f.key)}
                  placeholder="(built-in default)"
                  onChange={(e) => {
                    setValues({ ...values, [f.key]: e.target.value });
                    setTouched({ ...touched, [f.key]: true });
                  }}
                />
              ) : (
                <Textarea
                  id={id}
                  className="pv-mono"
                  rows={f.key === "donate.tiers" ? 6 : 3}
                  value={shown(f.key)}
                  placeholder="(built-in default)"
                  onChange={(e) => {
                    setValues({ ...values, [f.key]: e.target.value });
                    setTouched({ ...touched, [f.key]: true });
                  }}
                />
              )
            }
          </Field>
        ))}
      </Section>
    </div>
  );
}
