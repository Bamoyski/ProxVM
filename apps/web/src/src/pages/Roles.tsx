import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox, Section, Empty, Btn, useConfirm } from "../components/ui.js";

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

export default function Roles() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
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
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm({ name: "", description: "", permissions: [] });
    setError(null);
  };

  const save = async () => {
    setError(null);
    try {
      if (editingId) {
        await api(`/roles/${editingId}`, {
          method: "PATCH",
          body: { name: form.name, description: form.description, permissions: form.permissions },
        });
      } else {
        await api("/roles", { method: "POST", body: form });
      }
      cancelEdit();
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const del = (role: Role) => {
    confirm(`Delete role ${role.name}? Assignments to users and groups are removed.`, `DELETE ${role.name}`, async () => {
      await api(`/roles/${role.id}`, { method: "DELETE" });
      reload();
    });
  };

  return (
    <div className="pv-page">
      <PageTitle title="Roles" description="Named permission sets assigned to users and groups." />
      {dialog}
      {error && <ErrorBox error={error} />}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-x-10">
        <Section title={editingId ? "Edit role" : "Create custom role"}>
          <div className="pv-field">
            <label className="pv-label">Name</label>
            <input className="pv-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="pv-field">
            <label className="pv-label">Description</label>
            <input className="pv-input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="pv-field">
            <label className="pv-label">Permissions ({form.permissions.length} selected)</label>
            <div style={{ maxHeight: 256, overflowY: "auto", border: "1px solid var(--pv-border-soft)", borderRadius: 6, padding: 10 }}>
              {grouped(catalog).map(([category, entries]) => (
                <div key={category} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--pv-text-3)", marginBottom: 4 }}>{category}</div>
                  {entries.map((p) => (
                    <label key={p.code} className="pv-checkrow" style={{ padding: "3px 0", cursor: "pointer" }} title={p.description}>
                      <input type="checkbox" checked={form.permissions.includes(p.code)} onChange={() => togglePerm(p.code)} />
                      <span className="pv-mono">{p.code}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn kind="primary" onClick={save} disabled={!form.name.trim()}>
              {editingId ? "Save changes" : "Create role"}
            </Btn>
            {editingId && (
              <Btn onClick={cancelEdit}>Cancel</Btn>
            )}
          </div>
        </Section>
        <div className="lg:col-span-2">
          <Section title="All roles" hint={`${(rolesData?.roles ?? []).length} total`}>
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Permissions</th>
                    <th className="num">Users</th>
                    <th className="num">Groups</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(rolesData?.roles ?? []).map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.name}
                        {r.is_system && (
                          <span className="pv-mono" style={{ marginLeft: 6, color: "var(--pv-text-3)" }} title="Built-in roles cannot be modified or deleted">
                            built-in
                          </span>
                        )}
                        {r.description && <div style={{ fontSize: "0.76rem", color: "var(--pv-text-3)" }}>{r.description}</div>}
                      </td>
                      <td style={{ color: "var(--pv-text-2)" }}>
                        <span title={r.permissions.join(", ")}>{r.permissions.length} permissions</span>
                      </td>
                      <td className="num pv-mono">{r.userCount}</td>
                      <td className="num pv-mono">{r.groupCount}</td>
                      <td>
                        {!r.is_system && (
                          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                            <Btn size="sm" kind="link" onClick={() => startEdit(r)}>Edit</Btn>
                            <Btn size="sm" kind="link" onClick={() => del(r)}>Delete</Btn>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rolesData?.roles.length && <Empty title="No roles" />}
          </Section>
        </div>
      </div>
    </div>
  );
}
