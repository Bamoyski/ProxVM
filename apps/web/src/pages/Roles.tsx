import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox, useConfirm } from "../components/ui.js";

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

const input = "w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm";
const label = "block text-xs font-medium text-slate-400 mb-1";

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
    <div>
      <PageTitle title="Roles" />
      {dialog}
      {error && <ErrorBox error={error} />}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-3">{editingId ? "Edit role" : "Create custom role"}</h2>
          <div className="space-y-3">
            <div>
              <label className={label}>Name</label>
              <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className={label}>Description</label>
              <input className={input} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div>
              <label className={label}>Permissions ({form.permissions.length} selected)</label>
              <div className="max-h-64 overflow-y-auto space-y-2">
                {grouped(catalog).map(([category, entries]) => (
                  <div key={category}>
                    <div className="text-xs text-slate-500 mb-1">{category}</div>
                    {entries.map((p) => (
                      <label key={p.code} className="flex items-start gap-2 text-sm text-slate-300 cursor-pointer" title={p.description}>
                        <input type="checkbox" className="mt-1" checked={form.permissions.includes(p.code)} onChange={() => togglePerm(p.code)} />
                        <span className="font-mono text-xs">{p.code}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={save}
                disabled={!form.name.trim()}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded"
              >
                {editingId ? "Save changes" : "Create role"}
              </button>
              {editingId && (
                <button onClick={cancelEdit} className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded">
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-3">All roles</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
                <th className="py-2">Role</th>
                <th className="py-2">Permissions</th>
                <th className="py-2">Users</th>
                <th className="py-2">Groups</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(rolesData?.roles ?? []).map((r) => (
                <tr key={r.id} className="border-b border-slate-800/50">
                  <td className="py-2">
                    {r.name}
                    {r.is_system && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide bg-slate-800 text-slate-400 rounded px-1.5 py-0.5" title="Built-in roles cannot be modified or deleted">
                        built-in
                      </span>
                    )}
                    {r.description && <div className="text-xs text-slate-500">{r.description}</div>}
                  </td>
                  <td className="text-xs text-slate-400 max-w-xs">
                    <span title={r.permissions.join(", ")}>{r.permissions.length} permissions</span>
                  </td>
                  <td className="font-mono">{r.userCount}</td>
                  <td className="font-mono">{r.groupCount}</td>
                  <td>
                    {!r.is_system && (
                      <div className="flex gap-2 justify-end">
                        <button className="text-xs underline" onClick={() => startEdit(r)}>Edit</button>
                        <button className="text-xs text-red-300 underline" onClick={() => del(r)}>Delete</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
