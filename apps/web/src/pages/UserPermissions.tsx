import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox } from "../components/ui.js";

interface CatalogEntry {
  code: string;
  category: string;
  description: string;
}

interface EffectiveView {
  user: { id: string; username: string; roles: string[]; active: boolean };
  permissions: Array<{ permission: string; sources: string[] }>;
  vmAccess: Array<{ vmId: string; protocols: string[] | null; expiresAt: string | null; sources: string[] }>;
  roles: string[];
  roleAssignments: Array<{ roleId: string; roleName: string; expiresAt: string | null }>;
  groups: Array<{ id: string; name: string }>;
}

interface Role {
  id: string;
  name: string;
}

const input = "bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm";
const label = "block text-xs font-medium text-slate-400 mb-1";
const btn = "px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-40";

export default function UserPermissions() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [rolePick, setRolePick] = useState("");
  const [roleExpiry, setRoleExpiry] = useState("");
  const [permPick, setPermPick] = useState("");
  const [permExpiry, setPermExpiry] = useState("");

  const { data } = useQuery({
    queryKey: ["user-permissions", id],
    queryFn: () => api<EffectiveView>(`/users/${id}/permissions`),
  });
  const { data: rolesData } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api<{ roles: Role[] }>("/roles"),
  });
  const { data: catalogData } = useQuery({
    queryKey: ["iam-catalog"],
    queryFn: () => api<{ permissions: CatalogEntry[] }>("/iam/catalog"),
  });

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["user-permissions", id] });
  };

  const expiryBody = (expiry: string): Record<string, unknown> => {
    if (!expiry) return {};
    const ms = expiry === "1h" ? 3600_000 : expiry === "1d" ? 86400_000 : 7 * 86400_000;
    return { expiresAt: new Date(Date.now() + ms).toISOString() };
  };

  const mutate = async (fn: () => Promise<unknown>, okMsg: string) => {
    setError(null);
    setStatus(null);
    try {
      await fn();
      setStatus(okMsg);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const held = new Set((data?.permissions ?? []).map((p) => p.permission));
  const byCategory = new Map<string, CatalogEntry[]>();
  for (const p of catalogData?.permissions ?? []) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  return (
    <div>
      <div className="mb-4">
        <Link to="/users" className="text-blue-400 text-sm hover:underline">← Users</Link>
      </div>
      <PageTitle title={`Permissions — ${data?.user.username ?? "…"}`} />
      {error && <ErrorBox error={error} />}
      {status && <div className="bg-green-900/50 border border-green-700 text-green-200 rounded p-3 mb-4 text-sm">{status}</div>}
      {!data ? (
        <div className="text-slate-400">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded p-4">
              <h2 className="text-sm font-medium text-slate-300 mb-1">Roles</h2>
              <div className="text-xs text-slate-500 mb-2">Direct assignments with expiry and removal; group roles appear below.</div>
              <div className="space-y-1 mb-3">
                {(data.roleAssignments ?? []).map((a) => (
                  <div key={a.roleId} className="flex justify-between text-sm py-0.5">
                    <span>
                      {a.roleName}
                      <span className="text-xs text-slate-500 ml-2">
                        direct · {a.expiresAt ? `expires ${new Date(a.expiresAt).toLocaleString()}` : "never expires"}
                      </span>
                    </span>
                    <button
                      className="text-xs text-red-300 underline"
                      onClick={() => void mutate(() => api(`/users/${id}/roles/${a.roleId}`, { method: "DELETE" }), `Removed ${a.roleName}.`)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {!(data.roleAssignments ?? []).length && <div className="text-xs text-slate-500">No direct role assignments.</div>}
              </div>
              <div className="space-y-1 mb-3">
                {data.roles
                  .filter((r) => !(data.roleAssignments ?? []).some((a) => a.roleName === r))
                  .map((r) => (
                    <div key={r} className="text-sm text-slate-200">
                      • {r} <span className="text-xs text-slate-500">via group</span>
                    </div>
                  ))}
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                <select className={input} value={rolePick} onChange={(e) => setRolePick(e.target.value)}>
                  <option value="">Select role…</option>
                  {(rolesData?.roles ?? []).map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
                <select className={input} value={roleExpiry} onChange={(e) => setRoleExpiry(e.target.value)}>
                  <option value="">Never expires</option>
                  <option value="1h">1 hour</option>
                  <option value="1d">1 day</option>
                  <option value="1w">1 week</option>
                </select>
                <button
                  className={btn}
                  disabled={!rolePick}
                  onClick={() =>
                    void mutate(
                      () => api(`/users/${id}/roles`, { method: "POST", body: { roleId: rolePick, ...expiryBody(roleExpiry) } }),
                      "Role assigned.",
                    ).then(() => {
                      setRolePick("");
                      setRoleExpiry("");
                    })
                  }
                >
                  Assign role
                </button>
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded p-4">
              <h2 className="text-sm font-medium text-slate-300 mb-1">Direct permission grants</h2>
              <div className="text-xs text-slate-500 mb-2">Only for permissions outside the user's roles. Admins cannot grant what they lack.</div>
              <div className="flex flex-wrap gap-2 items-center">
                <select className={input} value={permPick} onChange={(e) => setPermPick(e.target.value)}>
                  <option value="">Select permission…</option>
                  {(catalogData?.permissions ?? [])
                    .filter((p) => !held.has(p.code))
                    .map((p) => (
                      <option key={p.code} value={p.code}>{p.code}</option>
                    ))}
                </select>
                <select className={input} value={permExpiry} onChange={(e) => setPermExpiry(e.target.value)}>
                  <option value="">Never expires</option>
                  <option value="1h">1 hour</option>
                  <option value="1d">1 day</option>
                  <option value="1w">1 week</option>
                </select>
                <button
                  className={btn}
                  disabled={!permPick}
                  onClick={() =>
                    void mutate(
                      () => api(`/users/${id}/permissions`, { method: "POST", body: { permission: permPick, ...expiryBody(permExpiry) } }),
                      `Granted ${permPick}.`,
                    ).then(() => {
                      setPermPick("");
                      setPermExpiry("");
                    })
                  }
                >
                  Grant
                </button>
              </div>
              <div className="mt-3 space-y-1">
                {(data.permissions ?? [])
                  .filter((p) => p.sources.includes("direct grant"))
                  .map((p) => (
                    <div key={p.permission} className="flex justify-between text-sm">
                      <span className="font-mono text-xs">{p.permission}</span>
                      <button
                        className="text-xs text-red-300 underline"
                        onClick={() => void mutate(() => api(`/users/${id}/permissions/${p.permission}`, { method: "DELETE" }), `Revoked ${p.permission}.`)}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded p-4">
              <h2 className="text-sm font-medium text-slate-300 mb-2">Groups</h2>
              {(data.groups ?? []).map((g) => (
                <div key={g.id} className="text-sm text-slate-200">• {g.name}</div>
              ))}
              {!data.groups.length && <div className="text-xs text-slate-500">No group memberships. Manage them on the Groups page.</div>}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded p-4 h-fit">
            <h2 className="text-sm font-medium text-slate-300 mb-2">Effective permissions</h2>
            <div className="text-xs text-slate-500 mb-3">✓ granted (hover for source) · — denied. Inherited grants look the same as explicit ones here by design; the tooltip names the source.</div>
            <div className="space-y-3 max-h-[32rem] overflow-y-auto">
              {[...byCategory.entries()].map(([category, entries]) => (
                <div key={category}>
                  <div className="text-xs text-slate-500 mb-1">{category}</div>
                  {entries.map((p) => {
                    const hit = data.permissions.find((x) => x.permission === p.code);
                    return (
                      <div key={p.code} className="flex justify-between text-sm py-0.5" title={hit ? hit.sources.join("; ") : p.description}>
                        <span className="font-mono text-xs">{p.code}</span>
                        {hit ? <span className="text-green-400">✓</span> : <span className="text-slate-700">—</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <h2 className="text-sm font-medium text-slate-300 mt-4 mb-2">VM access</h2>
            {(data.vmAccess ?? []).map((v) => (
              <div key={v.vmId} className="text-sm py-0.5">
                <span className="font-mono text-xs">{v.vmId.slice(0, 8)}</span>
                <span className="text-xs text-slate-400 ml-2">
                  {v.protocols === null ? "all protocols" : v.protocols.join(", ").toUpperCase()}
                  {v.expiresAt ? ` · expires ${new Date(v.expiresAt).toLocaleString()}` : ""}
                </span>
                <div className="text-xs text-slate-500">{v.sources.join("; ")}</div>
              </div>
            ))}
            {!data.vmAccess.length && <div className="text-xs text-slate-500">No VM access.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
