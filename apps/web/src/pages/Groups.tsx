import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox, Section, Empty, Btn, useConfirm } from "../components/ui.js";

interface Group {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  roleCount: number;
  vmCount: number;
}

interface GroupPermission {
  code: string;
  category: string;
  description: string;
  scope: string;
  roles: string[];
}

interface GroupDetail extends Group {
  members: Array<{ userId: string; username: string; expiresAt: string | null }>;
  roles: Array<{ roleId: string; roleName: string; expiresAt: string | null }>;
  vms: Array<{ vmId: string; vmName: string; vmid: number; node: string; protocols: string[] | null; expiresAt: string | null }>;
  permissions: GroupPermission[];
}

interface Role {
  id: string;
  name: string;
}

const input = "pv-input";
const label = "pv-label";

function fmtExpiry(v: string | null): string {
  if (!v) return "never";
  return new Date(v).toLocaleString();
}

export default function Groups() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const { data: groupsData } = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<{ groups: Group[] }>("/groups"),
  });
  const { data: rolesData } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api<{ roles: Role[] }>("/roles"),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", description: "" });
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [memberInput, setMemberInput] = useState("");
  const [memberExpiry, setMemberExpiry] = useState("");
  const [rolePick, setRolePick] = useState("");
  const [vmForm, setVmForm] = useState({ vmId: "", protocols: null as string[] | null, expiry: "" });

  const { data: detailData } = useQuery({
    queryKey: ["group", selectedId],
    queryFn: () => api<{ group: Group; members: GroupDetail["members"]; roles: GroupDetail["roles"]; vms: GroupDetail["vms"]; permissions: GroupPermission[] }>(`/groups/${selectedId}`),
    enabled: !!selectedId,
  });

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["groups"] });
    void qc.invalidateQueries({ queryKey: ["group", selectedId] });
  };

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const create = async () => {
    setError(null);
    try {
      const res = await api<{ group: Group }>("/groups", { method: "POST", body: form });
      setForm({ name: "", description: "" });
      setSelectedId(res.group.id);
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const del = (group: Group) => {
    confirm(`Delete group ${group.name}? Memberships, role links and VM access are removed.`, `DELETE ${group.name}`, async () => {
      await api(`/groups/${group.id}`, { method: "DELETE" });
      if (selectedId === group.id) setSelectedId(null);
      reload();
    });
  };

  const expiryBody = (expiry: string): Record<string, unknown> => {
    if (!expiry) return {};
    const ms = expiry === "1h" ? 3600_000 : expiry === "1d" ? 86400_000 : 7 * 86400_000;
    return { expiresAt: new Date(Date.now() + ms).toISOString() };
  };

  const mutate = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setError(null);
    setStatus(null);
    try {
      await fn();
      if (okMsg) setStatus(okMsg);
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const detail = detailData;

  return (
    <div className="pv-page">
      <PageTitle title="Groups" description="Bundle users, roles, and VM access. Group-derived access is managed here, not per VM." />
      {dialog}
      {error && <ErrorBox error={error} />}
      {status && <div className="pv-notice pv-notice-ok">{status}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-x-10">
        <div>
          <Section title="Create group">
            <div className="pv-field">
              <label className={label}>Name</label>
              <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="pv-field">
              <label className={label}>Description</label>
              <input className={input} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <Btn kind="primary" onClick={create} disabled={!form.name.trim()}>
              Create group
            </Btn>
          </Section>
          <Section title="All groups" hint={`${(groupsData?.groups ?? []).length} total`}>
            {(groupsData?.groups ?? []).map((g) => (
              <div key={g.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--pv-border-soft)" }}>
                <button
                  className="pv-btn pv-btn-link"
                  style={{ fontSize: "0.85rem", color: selectedId === g.id ? "var(--pv-accent)" : "var(--pv-text)" }}
                  onClick={() => setSelectedId(g.id)}
                >
                  {g.name}
                  <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)", marginLeft: 8 }}>{g.memberCount} members · {g.vmCount} VMs</span>
                </button>
                <Btn size="sm" kind="link" onClick={() => del(g)}>Delete</Btn>
              </div>
            ))}
            {!groupsData?.groups.length && <Empty title="No groups yet" />}
          </Section>
        </div>
        <div className="lg:col-span-2">
          {!detail ? (
            <Empty title="No group selected" body="Select a group to manage members, roles and VM access." />
          ) : (
            <div>
              <Section title={detail.group.name} hint={detail.group.description || undefined}>
                <div className="pv-label">Members</div>
                <div style={{ marginBottom: 12 }}>
                  {detail.members.map((m) => (
                    <div key={m.userId} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
                      <span>
                        {m.username}
                        <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)", marginLeft: 8 }}>expires {fmtExpiry(m.expiresAt)}</span>
                      </span>
                      <Btn
                        size="sm"
                        kind="link"
                        onClick={() => void mutate(() => api(`/groups/${detail.group.id}/members/${m.userId}`, { method: "DELETE" }))}
                      >
                        Remove
                      </Btn>
                    </div>
                  ))}
                  {!detail.members.length && <Empty title="No members" />}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <input
                    className="pv-input"
                    style={{ width: 192 }}
                    placeholder="Username to add…"
                    value={memberInput}
                    onChange={(e) => setMemberInput(e.target.value)}
                  />
                  <select className="pv-select pv-input-auto" style={{ height: 32, fontSize: "0.8rem" }} value={memberExpiry} onChange={(e) => setMemberExpiry(e.target.value)}>
                    <option value="">Never expires</option>
                    <option value="1h">1 hour</option>
                    <option value="1d">1 day</option>
                    <option value="1w">1 week</option>
                  </select>
                  <Btn
                    size="sm"
                    kind="primary"
                    disabled={!memberInput.trim()}
                    onClick={() =>
                      void mutate(
                        () => api(`/groups/${detail.group.id}/members`, { method: "POST", body: { username: memberInput.trim(), ...expiryBody(memberExpiry) } }),
                        `Added ${memberInput.trim()} to ${detail.group.name}.`,
                      ).then(() => setMemberInput(""))
                    }
                  >
                    Add member
                  </Btn>
                </div>
              </Section>
              <Section title="Roles">
                <div style={{ marginBottom: 12 }}>
                  {detail.roles.map((r) => (
                    <div key={r.roleId} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
                      <span>
                        {r.roleName}
                        <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)", marginLeft: 8 }}>expires {fmtExpiry(r.expiresAt)}</span>
                      </span>
                      <Btn
                        size="sm"
                        kind="link"
                        onClick={() => void mutate(() => api(`/groups/${detail.group.id}/roles/${r.roleId}`, { method: "DELETE" }))}
                      >
                        Remove
                      </Btn>
                    </div>
                  ))}
                  {!detail.roles.length && <Empty title="No roles" />}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select className="pv-select pv-input-auto" style={{ height: 32 }} value={rolePick} onChange={(e) => setRolePick(e.target.value)}>
                    <option value="">Select role…</option>
                    {(rolesData?.roles ?? []).map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                  <Btn
                    size="sm"
                    kind="primary"
                    disabled={!rolePick}
                    onClick={() =>
                      void mutate(() => api(`/groups/${detail.group.id}/roles`, { method: "POST", body: { roleId: rolePick } })).then(() => setRolePick(""))
                    }
                  >
                    Assign role
                  </Btn>
                </div>
              </Section>
              <Section title="Effective permissions" hint="Union of permissions from the group's roles.">
                <GroupPermissions permissions={detailData.permissions ?? []} />
              </Section>
              <Section title="VM access">
                <div style={{ marginBottom: 12 }}>
                  {detail.vms.map((v) => (
                    <div key={v.vmId} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
                      <span>
                        {v.vmName} <span className="pv-mono" style={{ color: "var(--pv-text-3)" }}>({v.vmid}@{v.node})</span>
                        <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)", marginLeft: 8 }}>
                          {v.protocols === null ? "all protocols" : v.protocols.join(", ").toUpperCase()} · expires {fmtExpiry(v.expiresAt)}
                        </span>
                      </span>
                      <Btn
                        size="sm"
                        kind="link"
                        onClick={() => void mutate(() => api(`/groups/${detail.group.id}/vms/${v.vmId}`, { method: "DELETE" }))}
                      >
                        Remove
                      </Btn>
                    </div>
                  ))}
                  {!detail.vms.length && <Empty title="No VMs" />}
                </div>
                <GroupVmGrant
                  groupId={detail.group.id}
                  vmForm={vmForm}
                  setVmForm={setVmForm}
                  onGrant={(msg) => setStatus(msg)}
                  onError={fail}
                  reload={reload}
                />
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupPermissions({ permissions }: { permissions: GroupPermission[] }) {
  if (!permissions.length) return <Empty title="No permissions via roles" />;
  const byCategory = new Map<string, GroupPermission[]>();
  for (const p of permissions) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }
  return (
    <div>
      {[...byCategory.entries()].map(([category, perms]) => (
        <div key={category} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--pv-text-3)", marginBottom: 4 }}>{category}</div>
          {perms.map((p) => (
            <div key={p.code} style={{ fontSize: "0.83rem", padding: "3px 0" }} title={p.description}>
              <span className="pv-mono">{p.code}</span>
              <span style={{ color: "var(--pv-text-2)", marginLeft: 8 }}>{p.description}</span>
              <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)", marginLeft: 8 }}>via {p.roles.join(", ")}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function GroupVmGrant({ groupId, vmForm, setVmForm, onGrant, onError, reload }: {
  groupId: string;
  vmForm: { vmId: string; protocols: string[] | null; expiry: string };
  setVmForm: (v: { vmId: string; protocols: string[] | null; expiry: string }) => void;
  onGrant: (msg: string) => void;
  onError: (err: unknown) => void;
  reload: () => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <input
        className="pv-input pv-mono"
        style={{ width: 256 }}
        placeholder="VM id (see URL on VM page)…"
        value={vmForm.vmId}
        onChange={(e) => setVmForm({ ...vmForm, vmId: e.target.value })}
      />
      <label className="pv-checkrow">
        <input
          type="checkbox"
          checked={vmForm.protocols === null}
          onChange={(e) => setVmForm({ ...vmForm, protocols: e.target.checked ? null : ["ssh", "rdp", "vnc"] })}
        />
        All protocols
      </label>
      {["ssh", "rdp", "vnc"].map((p) => (
        <label key={p} className="pv-checkrow" style={{ textTransform: "uppercase" }}>
          <input
            type="checkbox"
            checked={vmForm.protocols === null || vmForm.protocols.includes(p)}
            disabled={vmForm.protocols === null}
            onChange={(e) =>
              setVmForm({
                ...vmForm,
                protocols: e.target.checked
                  ? [...new Set([...(vmForm.protocols ?? ["ssh", "rdp", "vnc"]), p])]
                  : (vmForm.protocols ?? ["ssh", "rdp", "vnc"]).filter((x) => x !== p),
              })
            }
          />
          {p}
        </label>
      ))}
      <select
        className="pv-select pv-input-auto"
        style={{ height: 32, fontSize: "0.8rem" }}
        value={vmForm.expiry}
        onChange={(e) => setVmForm({ ...vmForm, expiry: e.target.value })}
      >
        <option value="">Never expires</option>
        <option value="1h">1 hour</option>
        <option value="1d">1 day</option>
        <option value="1w">1 week</option>
      </select>
      <Btn
        size="sm"
        kind="primary"
        disabled={!vmForm.vmId.trim()}
        onClick={() => {
          const body: Record<string, unknown> = { vmId: vmForm.vmId.trim() };
          if (vmForm.protocols !== null) body.protocols = vmForm.protocols;
          if (vmForm.expiry) {
            const ms = vmForm.expiry === "1h" ? 3600_000 : vmForm.expiry === "1d" ? 86400_000 : 7 * 86400_000;
            body.expiresAt = new Date(Date.now() + ms).toISOString();
          }
          api(`/groups/${groupId}/vms`, { method: "POST", body })
            .then(() => {
              setVmForm({ vmId: "", protocols: null, expiry: "" });
              reload();
              onGrant("VM access granted to the group.");
            })
            .catch(onError);
        }}
      >
        Grant VM access
      </Btn>
    </div>
  );
}
