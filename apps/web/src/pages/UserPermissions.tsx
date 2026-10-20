import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageHeader, Section, EmptyState, Btn, Alert, errText } from "../ui/index.js";

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
      setError(errText(err));
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
    <div className="pv-page">
      <div style={{ marginBottom: 4 }}>
        <Link to="/users" style={{ fontSize: "0.8rem" }}>← Users</Link>
      </div>
      <PageHeader title={`Permissions — ${data?.user.username ?? "…"}`} description="Direct assignments plus everything inherited from groups. The right column is the computed result." />
      {error && <Alert kind="err" title="Action failed">{error}</Alert>}
      {status && <Alert kind="ok" title="Done">{status}</Alert>}
      {!data ? (
        <div style={{ color: "var(--pv-text-3)" }}>Loading…</div>
      ) : (
        <div className="pv-grid-2">
          <div>
            <Section title="Roles" hint="Direct assignments with expiry and removal; group roles appear below.">
              <div style={{ marginBottom: 12 }}>
                {(data.roleAssignments ?? []).map((a) => (
                  <div key={a.roleId} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
                    <span>
                      {a.roleName}
                      <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)", marginLeft: 8 }}>
                        direct · {a.expiresAt ? `expires ${new Date(a.expiresAt).toLocaleString()}` : "never expires"}
                      </span>
                    </span>
                    <Btn
                      size="sm"
                      kind="link"
                      onClick={() => void mutate(() => api(`/users/${id}/roles/${a.roleId}`, { method: "DELETE" }), `Removed ${a.roleName}.`)}
                    >
                      Remove
                    </Btn>
                  </div>
                ))}
                {!(data.roleAssignments ?? []).length && <EmptyState title="No direct role assignments" />}
              </div>
              <div style={{ marginBottom: 12 }}>
                {data.roles
                  .filter((r) => !(data.roleAssignments ?? []).some((a) => a.roleName === r))
                  .map((r) => (
                    <div key={r} style={{ fontSize: "0.85rem", padding: "2px 0" }}>
                      • {r} <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)" }}>via group</span>
                    </div>
                  ))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <select className="pv-select pv-input-auto" style={{ height: 32 }} aria-label="Role to assign" value={rolePick} onChange={(e) => setRolePick(e.target.value)}>
                  <option value="">Select role…</option>
                  {(rolesData?.roles ?? []).map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
                <select className="pv-select pv-input-auto" style={{ height: 32, fontSize: "0.8rem" }} aria-label="Role expiry" value={roleExpiry} onChange={(e) => setRoleExpiry(e.target.value)}>
                  <option value="">Never expires</option>
                  <option value="1h">1 hour</option>
                  <option value="1d">1 day</option>
                  <option value="1w">1 week</option>
                </select>
                <Btn
                  size="sm"
                  kind="primary"
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
                </Btn>
              </div>
            </Section>
            <Section title="Direct permission grants" hint="Only for permissions outside the user's roles. Admins cannot grant what they lack.">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
                <select className="pv-select pv-input-auto" style={{ height: 32 }} aria-label="Permission to grant" value={permPick} onChange={(e) => setPermPick(e.target.value)}>
                  <option value="">Select permission…</option>
                  {(catalogData?.permissions ?? [])
                    .filter((p) => !held.has(p.code))
                    .map((p) => (
                      <option key={p.code} value={p.code}>{p.code}</option>
                    ))}
                </select>
                <select className="pv-select pv-input-auto" style={{ height: 32, fontSize: "0.8rem" }} aria-label="Permission expiry" value={permExpiry} onChange={(e) => setPermExpiry(e.target.value)}>
                  <option value="">Never expires</option>
                  <option value="1h">1 hour</option>
                  <option value="1d">1 day</option>
                  <option value="1w">1 week</option>
                </select>
                <Btn
                  size="sm"
                  kind="primary"
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
                </Btn>
              </div>
              {(data.permissions ?? [])
                .filter((p) => p.sources.includes("direct grant"))
                .map((p) => (
                  <div key={p.permission} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
                    <span className="pv-mono">{p.permission}</span>
                    <Btn
                      size="sm"
                      kind="link"
                      onClick={() => void mutate(() => api(`/users/${id}/permissions/${p.permission}`, { method: "DELETE" }), `Revoked ${p.permission}.`)}
                    >
                      Revoke
                    </Btn>
                  </div>
                ))}
            </Section>
            <Section title="Groups">
              {(data.groups ?? []).map((g) => (
                <div key={g.id} style={{ fontSize: "0.85rem", padding: "2px 0" }}>• {g.name}</div>
              ))}
              {!data.groups.length && <EmptyState title="No group memberships" body="Manage them on the Groups page." />}
            </Section>
          </div>
          <Section title="Effective permissions" hint="✓ granted (hover for source) · — denied. Inherited grants look the same as explicit ones by design; the tooltip names the source.">
            <div style={{ maxHeight: "32rem", overflowY: "auto" }}>
              {[...byCategory.entries()].map(([category, entries]) => (
                <div key={category} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--pv-text-3)", marginBottom: 4 }}>{category}</div>
                  {entries.map((p) => {
                    const hit = data.permissions.find((x) => x.permission === p.code);
                    return (
                      <div key={p.code} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: "0.85rem" }} title={hit ? hit.sources.join("; ") : p.description}>
                        <span className="pv-mono">{p.code}</span>
                        {hit ? <span style={{ color: "var(--pv-ok)" }}>✓</span> : <span style={{ color: "var(--pv-text-3)" }}>—</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="pv-label" style={{ marginTop: 16, marginBottom: 6 }}>VM access</div>
            {(data.vmAccess ?? []).map((v) => (
              <div key={v.vmId} style={{ fontSize: "0.85rem", padding: "4px 0", borderBottom: "1px solid var(--pv-border-soft)" }}>
                <span className="pv-mono">{v.vmId.slice(0, 8)}</span>
                <span style={{ fontSize: "0.76rem", color: "var(--pv-text-2)", marginLeft: 8 }}>
                  {v.protocols === null ? "all protocols" : v.protocols.join(", ").toUpperCase()}
                  {v.expiresAt ? ` · expires ${new Date(v.expiresAt).toLocaleString()}` : ""}
                </span>
                <div style={{ fontSize: "0.76rem", color: "var(--pv-text-3)" }}>{v.sources.join("; ")}</div>
              </div>
            ))}
            {!data.vmAccess.length && <EmptyState title="No VM access" />}
          </Section>
        </div>
      )}
    </div>
  );
}
