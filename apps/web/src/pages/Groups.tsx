import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox, useConfirm } from "../components/ui.js";

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

const input = "w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm";
const label = "block text-xs font-medium text-slate-400 mb-1";
const btn = "px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-40";

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
    <div>
      <PageTitle title="Groups" />
      {dialog}
      {error && <ErrorBox error={error} />}
      {status && <div className="bg-green-900/50 border border-green-700 text-green-200 rounded p-3 mb-4 text-sm">{status}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div>
          <div className="bg-slate-900 border border-slate-800 rounded p-4 mb-4">
            <h2 className="text-sm font-medium text-slate-300 mb-3">Create group</h2>
            <div className="space-y-3">
              <div>
                <label className={label}>Name</label>
                <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <label className={label}>Description</label>
                <input className={input} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>
              <button onClick={create} disabled={!form.name.trim()} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded">
                Create group
              </button>
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded p-4">
            <h2 className="text-sm font-medium text-slate-300 mb-3">All groups</h2>
            <div className="space-y-1">
              {(groupsData?.groups ?? []).map((g) => (
                <div key={g.id} className="flex items-center justify-between">
                  <button
                    className={`text-sm text-left hover:underline ${selectedId === g.id ? "text-blue-400" : "text-slate-200"}`}
                    onClick={() => setSelectedId(g.id)}
                  >
                    {g.name}
                    <span className="text-xs text-slate-500 ml-2">{g.memberCount} members · {g.vmCount} VMs</span>
                  </button>
                  <button className="text-xs text-red-300 underline" onClick={() => del(g)}>Delete</button>
                </div>
              ))}
              {!groupsData?.groups.length && <div className="text-sm text-slate-500">No groups yet.</div>}
            </div>
          </div>
        </div>
        <div className="lg:col-span-2">
          {!detail ? (
            <div className="text-sm text-slate-500">Select a group to manage members, roles and VM access.</div>
          ) : (
            <div className="space-y-4">
              <div className="bg-slate-900 border border-slate-800 rounded p-4">
                <h2 className="text-sm font-medium text-slate-300 mb-1">{detail.group.name}</h2>
                {detail.group.description && <div className="text-xs text-slate-500 mb-3">{detail.group.description}</div>}
                <h3 className="text-xs font-medium text-slate-400 mb-2">Members</h3>
                <div className="space-y-1 mb-3">
                  {detail.members.map((m) => (
                    <div key={m.userId} className="flex justify-between text-sm py-0.5">
                      <span>
                        {m.username}
                        <span className="text-xs text-slate-500 ml-2">expires {fmtExpiry(m.expiresAt)}</span>
                      </span>
                      <button
                        className="text-xs text-red-300 underline"
                        onClick={() => void mutate(() => api(`/groups/${detail.group.id}/members/${m.userId}`, { method: "DELETE" }))}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {!detail.members.length && <div className="text-xs text-slate-500">No members.</div>}
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <input
                    className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm w-48"
                    placeholder="Username to add…"
                    value={memberInput}
                    onChange={(e) => setMemberInput(e.target.value)}
                  />
                  <select className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs" value={memberExpiry} onChange={(e) => setMemberExpiry(e.target.value)}>
                    <option value="">Never expires</option>
                    <option value="1h">1 hour</option>
                    <option value="1d">1 day</option>
                    <option value="1w">1 week</option>
                  </select>
                  <button
                    className={btn}
                    disabled={!memberInput.trim()}
                    onClick={() =>
                      void mutate(
                        () => api(`/groups/${detail.group.id}/members`, { method: "POST", body: { username: memberInput.trim(), ...expiryBody(memberExpiry) } }),
                        `Added ${memberInput.trim()} to ${detail.group.name}.`,
                      ).then(() => setMemberInput(""))
                    }
                  >
                    Add member
                  </button>
                </div>
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded p-4">
                <h3 className="text-xs font-medium text-slate-400 mb-2">Roles</h3>
                <div className="space-y-1 mb-3">
                  {detail.roles.map((r) => (
                    <div key={r.roleId} className="flex justify-between text-sm py-0.5">
                      <span>
                        {r.roleName}
                        <span className="text-xs text-slate-500 ml-2">expires {fmtExpiry(r.expiresAt)}</span>
                      </span>
                      <button
                        className="text-xs text-red-300 underline"
                        onClick={() => void mutate(() => api(`/groups/${detail.group.id}/roles/${r.roleId}`, { method: "DELETE" }))}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {!detail.roles.length && <div className="text-xs text-slate-500">No roles.</div>}
                </div>
                <div className="flex gap-2 items-center">
                  <select className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm" value={rolePick} onChange={(e) => setRolePick(e.target.value)}>
                    <option value="">Select role…</option>
                    {(rolesData?.roles ?? []).map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                  <button
                    className={btn}
                    disabled={!rolePick}
                    onClick={() =>
                      void mutate(() => api(`/groups/${detail.group.id}/roles`, { method: "POST", body: { roleId: rolePick } })).then(() => setRolePick(""))
                    }
                  >
                    Assign role
                  </button>
                </div>
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded p-4">
                <h3 className="text-xs font-medium text-slate-400 mb-2">Effective permissions</h3>
                <div className="text-xs text-slate-500 mb-2">Union of permissions from the group's roles.</div>
                <GroupPermissions permissions={detailData.permissions ?? []} />
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded p-4">
                <h3 className="text-xs font-medium text-slate-400 mb-2">VM access</h3>
                <div className="space-y-1 mb-3">
                  {detail.vms.map((v) => (
                    <div key={v.vmId} className="flex justify-between text-sm py-0.5">
                      <span>
                        {v.vmName} <span className="text-xs text-slate-500 font-mono">({v.vmid}@{v.node})</span>
                        <span className="text-xs text-slate-500 ml-2">
                          {v.protocols === null ? "all protocols" : v.protocols.join(", ").toUpperCase()} · expires {fmtExpiry(v.expiresAt)}
                        </span>
                      </span>
                      <button
                        className="text-xs text-red-300 underline"
                        onClick={() => void mutate(() => api(`/groups/${detail.group.id}/vms/${v.vmId}`, { method: "DELETE" }))}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {!detail.vms.length && <div className="text-xs text-slate-500">No VMs.</div>}
                </div>
                <GroupVmGrant
                  groupId={detail.group.id}
                  vmForm={vmForm}
                  setVmForm={setVmForm}
                  onGrant={(msg) => setStatus(msg)}
                  onError={fail}
                  reload={reload}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupPermissions({ permissions }: { permissions: GroupPermission[] }) {
  if (!permissions.length) return <div className="text-xs text-slate-500">No permissions via roles.</div>;
  const byCategory = new Map<string, GroupPermission[]>();
  for (const p of permissions) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }
  return (
    <div className="space-y-3">
      {[...byCategory.entries()].map(([category, perms]) => (
        <div key={category}>
          <div className="text-xs font-medium text-slate-400 mb-1">{category}</div>
          <div className="space-y-1">
            {perms.map((p) => (
              <div key={p.code} className="text-sm py-0.5" title={p.description}>
                <span className="font-mono text-blue-300">{p.code}</span>
                <span className="text-slate-400 ml-2">{p.description}</span>
                <span className="text-xs text-slate-500 ml-2">via {p.roles.join(", ")}</span>
              </div>
            ))}
          </div>
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
    <div className="flex flex-wrap gap-2 items-center">
      <input
        className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm w-64 font-mono"
        placeholder="VM id (see URL on VM page)…"
        value={vmForm.vmId}
        onChange={(e) => setVmForm({ ...vmForm, vmId: e.target.value })}
      />
      <label className="flex items-center gap-1 text-xs">
        <input
          type="checkbox"
          checked={vmForm.protocols === null}
          onChange={(e) => setVmForm({ ...vmForm, protocols: e.target.checked ? null : ["ssh", "rdp", "vnc"] })}
        />
        All protocols
      </label>
      {["ssh", "rdp", "vnc"].map((p) => (
        <label key={p} className="flex items-center gap-1 text-xs uppercase">
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
        className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs"
        value={vmForm.expiry}
        onChange={(e) => setVmForm({ ...vmForm, expiry: e.target.value })}
      >
        <option value="">Never expires</option>
        <option value="1h">1 hour</option>
        <option value="1d">1 day</option>
        <option value="1w">1 week</option>
      </select>
      <button
        className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-40"
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
      </button>
    </div>
  );
}
