import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, Empty, Btn } from "../components/ui.js";

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
    <div className="pv-page">
      <PageTitle title="Permission matrix" description="Who holds what, and where it comes from (role, group, direct grant)." />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16, alignItems: "center" }}>
        <input
          className="pv-input"
          style={{ width: 224 }}
          placeholder="Search users, roles, groups…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="pv-select pv-input-auto"
          style={{ height: 34 }}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <input
          className="pv-input"
          style={{ width: 224 }}
          placeholder="Filter permissions…"
          value={permissionFilter}
          onChange={(e) => setPermissionFilter(e.target.value)}
        />
        <label className="pv-checkrow">
          <input type="checkbox" checked={grantedOnly} onChange={(e) => setGrantedOnly(e.target.checked)} />
          Only holders (filter to exactly one permission)
        </label>
      </div>
      {selectedPerm && (
        <div className="pv-notice" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span className="pv-mono" style={{ fontSize: "0.95rem" }}>{selectedPerm.code}</span>
            <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)" }}>
              {selectedPerm.category} · scope: {selectedPerm.scope}
            </span>
            <Btn size="sm" kind="link" onClick={() => setSelected(null)}>Close</Btn>
          </div>
          <div style={{ marginTop: 4 }}>{selectedPerm.description}</div>
        </div>
      )}
      <div className="pv-table-wrap">
        <table className="pv-table">
          <thead>
            <tr>
              <th style={{ position: "sticky", left: 0 }}>User</th>
              {permList.map((p) => (
                <th key={p.code} className="pv-mono" style={{ fontWeight: 500, whiteSpace: "nowrap" }} title={p.description || p.code}>
                  {p.code}
                  <Btn
                    size="sm"
                    kind="link"
                    title={`About ${p.code}`}
                    aria-label={`About ${p.code}`}
                    onClick={() => setSelected(selectedPerm?.code === p.code ? null : p.code)}
                  >
                    ⓘ
                  </Btn>
                </th>
              ))}
              <th className="num">VMs</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user.id}>
                <td style={{ position: "sticky", left: 0, background: "var(--pv-surface)" }}>
                  {u.user.username}
                  <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)", marginLeft: 4 }}>({u.user.roles.join(", ")})</span>
                  {u.user.active === false && <span style={{ fontSize: "0.76rem", color: "var(--pv-err)", marginLeft: 4 }}>disabled</span>}
                </td>
                {permList.map((p) => {
                  const sources = has(u, p.code);
                  return (
                    <td key={p.code} style={{ textAlign: "center", color: sources ? "var(--pv-ok)" : "var(--pv-text-3)" }} title={sources ? sources.join("; ") : "not granted"}>
                      {sources ? "✓" : "—"}
                    </td>
                  );
                })}
                <td className="num pv-mono" title={u.vmAccess.map((v) => v.vmId).join(", ")}>
                  {u.vmAccess.length}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!users.length && <Empty title="No users match the current filters" />}
      <div className="pv-hint" style={{ marginTop: 8 }}>Hover a ✓ to see where each permission comes from (role, group, direct grant).</div>
    </div>
  );
}
