import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Minus } from "lucide-react";
import { api } from "../api.js";
import { PageHeader, EmptyState, Btn, Input, Select, Checkbox, SearchInput, TableSkeleton } from "../ui/index.js";

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

/** Read-only IAM matrix: who holds what, and where each grant comes from. */
export default function Matrix() {
  const { data, isLoading } = useQuery({
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
      <PageHeader title="Permission matrix" description="Who holds what, and where it comes from (role, group, direct grant)." />

      <div className="pv-toolbar">
        <SearchInput placeholder="Search users, roles, groups…" value={search} onChange={setSearch} label="Search matrix" />
        <Select autoWidth small value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category filter">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </Select>
        <Input
          small
          autoWidth
          placeholder="Filter permissions…"
          value={permissionFilter}
          onChange={(e) => setPermissionFilter(e.target.value)}
          aria-label="Filter permissions"
        />
        <Checkbox
          label="Only holders (requires exactly one permission)"
          checked={grantedOnly}
          onChange={(e) => setGrantedOnly(e.target.checked)}
        />
      </div>

      {selectedPerm && (
        <div className="pv-panel" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <code className="pv-mono" style={{ fontSize: "0.92rem" }}>{selectedPerm.code}</code>
            <span className="pv-faint" style={{ fontSize: "0.76rem" }}>
              {selectedPerm.category} · scope: {selectedPerm.scope}
            </span>
            <Btn size="sm" kind="link" style={{ marginLeft: "auto" }} onClick={() => setSelected(null)}>Close</Btn>
          </div>
          <div style={{ marginTop: 5 }}>{selectedPerm.description}</div>
        </div>
      )}

      {isLoading && !data ? (
        <div className="pv-table-wrap"><TableSkeleton rows={5} cols={6} /></div>
      ) : (
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, zIndex: 1 }}>User</th>
                {permList.map((p) => (
                  <th key={p.code} className="pv-mono" style={{ fontWeight: 500, whiteSpace: "nowrap" }} title={p.description || p.code}>
                    {p.code}
                    <Btn
                      size="sm"
                      kind="link"
                      title={`About ${p.code}`}
                      aria-label={`About ${p.code}`}
                      aria-expanded={selectedPerm?.code === p.code}
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
                    <span className="pv-faint" style={{ fontSize: "0.76rem", marginLeft: 4 }}>({u.user.roles.join(", ")})</span>
                    {u.user.active === false && <span style={{ fontSize: "0.76rem", color: "var(--pv-err)", marginLeft: 4 }}>disabled</span>}
                  </td>
                  {permList.map((p) => {
                    const sources = has(u, p.code);
                    return (
                      <td
                        key={p.code}
                        style={{
                          textAlign: "center",
                          color: sources ? "var(--pv-ok)" : "var(--pv-text-3)",
                          fontWeight: sources ? 700 : 400,
                        }}
                        title={sources ? sources.join("; ") : "not granted"}
                      >
                        {sources ? (
                          <Check size={14} strokeWidth={2.6} aria-hidden="true" />
                        ) : (
                          <Minus size={14} aria-hidden="true" />
                        )}
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
      )}
      {!isLoading && !users.length && <EmptyState title="No users match the current filters" />}
      <div className="pv-hint" style={{ marginTop: 8 }}>
        Hover a ✓ to see where each permission comes from (role, group, direct grant).
      </div>
    </div>
  );
}
