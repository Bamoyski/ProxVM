import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle } from "../components/ui.js";

interface CatalogPermission {
  code: string;
  category: string;
  description: string;
  scope: string;
}

interface MatrixUser {
  user: { id: string; username: string; roles: string[]; active: boolean };
  permissions: Array<{ permission: string; sources: string[] }>;
  vmAccess: Array<{ vmId: string; protocols: string[] | null; expiresAt: string | null }>;
  groups: Array<{ id: string; name: string }>;
}

export default function Matrix() {
  const { data } = useQuery({
    queryKey: ["iam-matrix"],
    queryFn: () =>
      api<{
        permissions: CatalogPermission[];
        users: MatrixUser[];
      }>("/iam/matrix"),
    refetchInterval: 30000,
  });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [grantedOnly, setGrantedOnly] = useState(false);
  const [permissionFilter, setPermissionFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const categories = useMemo(
    () => [...new Set((data?.permissions ?? []).map((p) => p.category))],
    [data],
  );

  const permList = useMemo(() => {
    let list = data?.permissions ?? [];
    if (category) list = list.filter((p) => p.category === category);
    if (permissionFilter) {
      const q = permissionFilter.toLowerCase();
      list = list.filter(
        (p) => p.code.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
      );
    }
    return list;
  }, [data, category, permissionFilter]);

  const selectedPerm = useMemo<CatalogPermission | null>(() => {
    const all = data?.permissions ?? [];
    if (selected) return all.find((p) => p.code === selected) ?? null;
    if (permList.length === 1 && permList[0]) return permList[0];
    return null;
  }, [data, selected, permList]);

  const users = useMemo(() => {
    let list = data?.users ?? [];
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (u) =>
          u.user.username.toLowerCase().includes(q) ||
          u.user.roles.some((r) => r.toLowerCase().includes(q)) ||
          u.groups.some((g) => g.name.toLowerCase().includes(q)),
      );
    }
    if (grantedOnly && permList.length === 1 && permList[0]) {
      const code = permList[0].code;
      list = list.filter((u) => u.permissions.some((p) => p.permission === code));
    }
    return list;
  }, [data, search, grantedOnly, permList]);

  const has = (u: MatrixUser, code: string): string[] | null => {
    const entry = u.permissions.find((p) => p.permission === code);
    return entry ? entry.sources : null;
  };

  return (
    <div>
      <PageTitle title="Permission Matrix" />
      <div className="flex flex-wrap gap-2 mb-4 items-center text-sm">
        <input
          className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 w-56"
          placeholder="Search users, roles, groups…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <input
          className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 w-56"
          placeholder="Filter permissions…"
          value={permissionFilter}
          onChange={(e) => setPermissionFilter(e.target.value)}
        />
        <label className="flex items-center gap-1 text-xs text-slate-300">
          <input type="checkbox" checked={grantedOnly} onChange={(e) => setGrantedOnly(e.target.checked)} />
          Only users holding the filtered permission (pick exactly one)
        </label>
      </div>
      {selectedPerm && (
        <div className="bg-slate-900 border border-slate-800 rounded p-4 mb-4">
          <div className="flex items-center gap-2">
            <span className="font-mono text-lg text-blue-300">{selectedPerm.code}</span>
            <span className="text-xs text-slate-500">
              {selectedPerm.category} · scope: {selectedPerm.scope}
            </span>
            <button
              className="ml-auto text-xs text-slate-400 hover:text-slate-200 underline"
              onClick={() => setSelected(null)}
            >
              Close
            </button>
          </div>
          <div className="text-slate-200 text-base mt-2">{selectedPerm.description}</div>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
              <th className="py-2 pr-4 sticky left-0 bg-slate-950">User</th>
              {permList.map((p) => (
                <th key={p.code} className="py-2 px-2 font-mono font-normal whitespace-nowrap" title={p.description || p.code}>
                  {p.code}
                  <button
                    className={`ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full border text-[10px] leading-none ${
                      selectedPerm?.code === p.code
                        ? "border-blue-400 text-blue-300"
                        : "border-slate-600 text-slate-400 hover:border-slate-300 hover:text-slate-200"
                    }`}
                    title={`About ${p.code}`}
                    aria-label={`About ${p.code}`}
                    onClick={() => setSelected(selectedPerm?.code === p.code ? null : p.code)}
                  >
                    i
                  </button>
                </th>
              ))}
              <th className="py-2 px-2">VMs</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user.id} className="border-b border-slate-800/50 hover:bg-slate-900/50">
                <td className="py-2 pr-4 sticky left-0 bg-slate-950">
                  {u.user.username}
                  <span className="text-xs text-slate-500 ml-1">({u.user.roles.join(", ")})</span>
                  {u.user.active === false && <span className="text-xs text-red-300 ml-1">disabled</span>}
                </td>
                {permList.map((p) => {
                  const sources = has(u, p.code);
                  return (
                    <td key={p.code} className="py-2 px-2 text-center" title={sources ? sources.join("; ") : "not granted"}>
                      {sources ? <span className="text-green-400">✓</span> : <span className="text-slate-700">—</span>}
                    </td>
                  );
                })}
                <td className="py-2 px-2 font-mono text-xs" title={u.vmAccess.map((v) => v.vmId).join(", ")}>
                  {u.vmAccess.length}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!users.length && <div className="text-sm text-slate-500 py-4">No users match the current filters.</div>}
      </div>
      <div className="text-xs text-slate-500 mt-2">Hover a column header for the permission description, or click its ⓘ button for details. Hover a ✓ to see where each permission comes from (role, group, direct grant).</div>
    </div>
  );
}
