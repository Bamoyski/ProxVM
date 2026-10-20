import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import {
  PageHeader, Section, EmptyState, Btn, Field, Input, Checkbox, Badge,
  useConfirm, useToast, errText,
} from "../ui/index.js";

interface Role {
  id: string;
  name: string;
  description: string;
  is_system: boolean;
  permissions: string[];
  userCount: number;
  groupCount: number;
}

interface CatalogEntry {
  code: string;
  category: string;
  description: string;
  scope: string;
}

function grouped(catalog: CatalogEntry[]): Array<[string, CatalogEntry[]]> {
  const map = new Map<string, CatalogEntry[]>();
  for (const entry of catalog) {
    const list = map.get(entry.category) ?? [];
    list.push(entry);
    map.set(entry.category, list);
  }
  return [...map.entries()];
}

/** Role editor: custom permission bundles on top of the built-in roles. */
export default function Roles() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const { data: rolesData } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api<{ roles: Role[] }>("/roles"),
  });
  const { data: catalogData } = useQuery({
    queryKey: ["iam-catalog"],
    queryFn: () => api<{ permissions: CatalogEntry[] }>("/iam/catalog"),
  });
  const [form, setForm] = useState({ name: "", description: "", permissions: [] as string[] });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const catalog = catalogData?.permissions ?? [];
  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["roles"] });
  };

  const togglePerm = (code: string) =>
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(code) ? f.permissions.filter((p) => p !== code) : [...f.permissions, code],
    }));

  const startEdit = (role: Role) => {
    setEditingId(role.id);
    setForm({ name: role.name, description: role.description, permissions: [...role.permissions] });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm({ name: "", description: "", permissions: [] });
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (editingId) {
        await api(`/roles/${editingId}`, {
          method: "PATCH",
          body: { name: form.name, description: form.description, permissions: form.permissions },
        });
        toast.ok("Role updated", `${form.name} — ${form.permissions.length} permission(s).`);
      } else {
        await api("/roles", { method: "POST", body: form });
        toast.ok("Role created", `${form.name} — assign it from Users or Groups.`);
      }
      cancelEdit();
      reload();
    } catch (err) {
      toast.err("Save failed", errText(err));
    } finally {
      setBusy(false);
    }
  };

  const del = async (role: Role) => {
    const ok = await confirm({
      title: `Delete role ${role.name}?`,
      danger: true,
      requireText: `DELETE ${role.name}`,
      confirmLabel: "Delete role",
      body: "Assignments of this role to users and groups are removed. Permissions they hold through other sources are unaffected.",
    });
    if (!ok) return;
    try {
      await api(`/roles/${role.id}`, { method: "DELETE" });
      toast.ok("Role deleted", role.name);
      reload();
    } catch (err) {
      toast.err("Delete failed", errText(err));
    }
  };

  return (
    <div className="pv-page">
      <PageHeader title="Roles" description="Named permission sets assigned to users and groups." />
      <div className="pv-grid-2">
        <Section title={editingId ? "Edit role" : "Create custom role"} hint="Nothing is granted by default — pick exactly what this role needs.">
          <Field label="Name" required>
            {({ id }) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
          </Field>
          <Field label="Description" hint="Shown in the role list.">
            {({ id }) => <Input id={id} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}
          </Field>
          <div className="pv-field">
            <span className="pv-label">Permissions ({form.permissions.length} selected)</span>
            <div style={{ maxHeight: 256, overflowY: "auto", border: "1px solid var(--pv-border-soft)", borderRadius: 6, padding: 10, background: "var(--pv-inset)" }}>
              {grouped(catalog).map(([category, entries]) => (
                <div key={category} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--pv-text-3)", marginBottom: 4 }}>{category}</div>
                  {entries.map((p) => (
                    <div key={p.code} title={p.description} style={{ padding: "2px 0" }}>
                      <Checkbox
                        label={<span className="pv-mono">{p.code}</span>}
                        checked={form.permissions.includes(p.code)}
                        onChange={() => togglePerm(p.code)}
                      />
                    </div>
                  ))}
                </div>
              ))}
              {!catalog.length && <div className="pv-faint" style={{ fontSize: "0.8rem" }}>Permission catalog loading…</div>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn kind="primary" loading={busy} onClick={() => void save()} disabled={!form.name.trim()}>
              {editingId ? "Save changes" : "Create role"}
            </Btn>
            {editingId && <Btn onClick={cancelEdit}>Cancel</Btn>}
          </div>
        </Section>

        <Section title="All roles" hint={`${(rolesData?.roles ?? []).length} total`}>
          <div className="pv-table-wrap">
            <table className="pv-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th className="num pv-hide-sm">Users</th>
                  <th className="num pv-hide-sm">Groups</th>
                  <th style={{ width: 110 }}><span className="pv-sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {(rolesData?.roles ?? []).map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span style={{ display: "inline-flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
                        {r.name}
                        {r.is_system && <Badge tone="plain">built-in</Badge>}
                      </span>
                      {r.description && <div className="pv-faint" style={{ fontSize: "0.76rem" }}>{r.description}</div>}
                    </td>
                    <td style={{ color: "var(--pv-text-2)" }}>
                      <span title={r.permissions.join(", ")}>{r.permissions.length} permissions</span>
                    </td>
                    <td className="num pv-mono pv-hide-sm">{r.userCount}</td>
                    <td className="num pv-mono pv-hide-sm">{r.groupCount}</td>
                    <td>
                      {!r.is_system && (
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <Btn size="sm" kind="link" onClick={() => startEdit(r)}>Edit</Btn>
                          <Btn size="sm" kind="link" onClick={() => void del(r)}>Delete</Btn>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rolesData?.roles.length && <EmptyState title="No roles" />}
        </Section>
      </div>
    </div>
  );
}
