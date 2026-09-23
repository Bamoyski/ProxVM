import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, StatusBadge, ErrorBox } from "../components/ui.js";

const ROLES = ["ADMIN", "OPERATOR", "USER"] as const;

export default function Users() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["users"],
    queryFn: () => api<{ users: Array<{ id: string; username: string; email: string | null; roles: string[]; active: boolean; isInitialAdmin: boolean; createdAt: string; lastLoginAt: string | null }> }>("/users"),
  });
  const [form, setForm] = useState({ username: "", email: "", password: "", role: "USER" as (typeof ROLES)[number] });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState({ a: "", b: "" });
  const [approveRole, setApproveRole] = useState<Record<string, string>>({});
  const { data: requestsData } = useQuery({
    queryKey: ["registration-requests"],
    queryFn: () => api<{ requests: Array<{ id: string; username: string; email: string | null; status: string; createdAt: string }> }>("/registration-requests?status=pending"),
    refetchInterval: 30000,
  });
  const { data: matrix } = useQuery({
    queryKey: ["iam-matrix"],
    queryFn: () =>
      api<{
        users: Array<{
          user: { id: string };
          vmAccess: Array<{ expiresAt: string | null }>;
          groups: Array<{ name: string }>;
        }>;
      }>("/iam/matrix"),
  });
  const matrixByUser = new Map((matrix?.users ?? []).map((m) => [m.user.id, m] as const));
  const input = "w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm";
  const label = "block text-xs font-medium text-slate-400 mb-1";

  const create = async () => {
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ user: { username: string }; guacSynced: boolean }>("/users", {
        method: "POST",
        body: { username: form.username, email: form.email || undefined, password: form.password, role: form.role },
      });
      setForm({ username: "", email: "", password: "", role: "USER" });
      if (res.guacSynced === false) {
        setNotice(
          `User ${res.user.username} created, but the Guacamole account could not be provisioned (Guacamole unavailable). It will be created automatically on first Guacamole launch.`,
        );
      }
      void qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const setRole = async (id: string, role: string) => {
    try {
      await api(`/users/${id}`, { method: "PUT", body: { role } });
      void qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleActive = async (id: string, active: boolean) => {
    try {
      await api(`/users/${id}`, { method: "PUT", body: { active } });
      void qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const resetPassword = async (id: string, username: string) => {
    setError(null);
    setNotice(null);
    try {
      await api(`/users/${id}`, { method: "PUT", body: { password: resetPw.a } });
      setResetId(null);
      setResetPw({ a: "", b: "" });
      setNotice(`Password reset for ${username}. All of their sessions were revoked; they must log in again.`);
      void qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const decideRegistration = async (id: string, approve: boolean) => {
    setError(null);
    setNotice(null);
    try {
      if (approve) {
        await api(`/registration-requests/${id}/approve`, {
          method: "POST",
          body: { role: approveRole[id] ?? "USER" },
        });
        setNotice("Account approved — the user can now sign in.");
      } else {
        await api(`/registration-requests/${id}/reject`, { method: "POST" });
        setNotice("Request rejected.");
      }
      void qc.invalidateQueries({ queryKey: ["registration-requests"] });
      void qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const del = (username: string, id: string) => {
    if (window.confirm(`Delete user ${username}? Their Guacamole account will also be removed.`)) {
      api(`/users/${id}`, { method: "DELETE" })
        .then(() => qc.invalidateQueries({ queryKey: ["users"] }))
        .catch((err) => alert(err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <div>
      <PageTitle title="Users" />
      {error && <ErrorBox error={error} />}
      {notice && (
        <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-200 rounded p-3 mb-4 text-sm">{notice}</div>
      )}
      {(requestsData?.requests ?? []).length > 0 && (
        <div className="bg-slate-900 border border-amber-700/60 rounded p-4 mb-4">
          <h2 className="text-sm font-medium text-slate-300 mb-1">
            Pending account requests ({requestsData?.requests.length})
          </h2>
          <div className="text-xs text-slate-500 mb-3">Approving creates the account immediately with the chosen role.</div>
          <div className="space-y-2">
            {(requestsData?.requests ?? []).map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span>
                  {r.username}
                  {r.email && <span className="text-xs text-slate-500 ml-1">{r.email}</span>}
                </span>
                <span className="text-xs text-slate-500">requested {new Date(r.createdAt).toLocaleString()}</span>
                <select
                  className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs"
                  value={approveRole[r.id] ?? "USER"}
                  onChange={(e) => setApproveRole({ ...approveRole, [r.id]: e.target.value })}
                >
                  {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                </select>
                <button className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded" onClick={() => void decideRegistration(r.id, true)}>
                  Approve
                </button>
                <button className="text-xs text-red-300 underline" onClick={() => void decideRegistration(r.id, false)}>
                  Reject
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-3">Create user</h2>
          <div className="space-y-3">
            <input className={input} placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            <input className={input} placeholder="Email (optional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input type="password" className={input} placeholder="Password (min 12, mixed case, number, symbol)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as (typeof ROLES)[number] })}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button onClick={create} disabled={!form.username || !form.password} className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded text-sm">
              Create user
            </button>
          </div>
          <div className="mt-4 text-xs text-slate-500 space-y-1">
            <div><b>ADMIN</b>: everything</div>
            <div><b>OPERATOR</b>: create/manage VMs, rotate credentials, access assigned connections</div>
            <div><b>USER</b>: access assigned VMs, launch Guacamole</div>
          </div>
        </div>
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded p-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
                <th className="py-2">User</th>
                <th className="py-2">Role</th>
                <th className="py-2">Groups</th>
                <th className="py-2">VMs</th>
                <th className="py-2">Status</th>
                <th className="py-2">Last login</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(data?.users ?? []).map((u) => {
                const activeAdminCount = (data?.users ?? []).filter(
                  (x) => x.roles.includes("ADMIN") && x.active,
                ).length;
                const onlyAdmin = u.roles.includes("ADMIN") && u.active && activeAdminCount <= 1;
                const roleLocked = u.isInitialAdmin;
                const deleteBlocked = u.isInitialAdmin || onlyAdmin;
                return (
                <tr key={u.id} className="border-b border-slate-800/50">
                  <td className="py-2">
                    {u.username}
                    {u.email && <span className="text-xs text-slate-500 ml-1">{u.email}</span>}
                    {u.isInitialAdmin && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide bg-slate-800 text-slate-300 rounded px-1.5 py-0.5" title="The initial administrator created during setup. Its role cannot be changed and it cannot be deleted.">
                        initial admin
                      </span>
                    )}
                  </td>
                  <td>
                    <select
                      className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs disabled:opacity-50"
                      value={u.roles[0] ?? "USER"}
                      disabled={roleLocked}
                      title={roleLocked ? "The initial administrator's role cannot be changed." : undefined}
                      onChange={(e) => void setRole(u.id, e.target.value)}
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td className="text-xs text-slate-400">
                    {(matrixByUser.get(u.id)?.groups ?? []).map((g) => g.name).join(", ") || "—"}
                  </td>
                  <td className="text-xs text-slate-400">
                    {(() => {
                      const info = matrixByUser.get(u.id);
                      if (!info) return "—";
                      const temp = info.vmAccess.filter((v) => v.expiresAt).length;
                      return `${info.vmAccess.length} VM${info.vmAccess.length === 1 ? "" : "s"}${temp ? ` (${temp} temporary)` : ""}`;
                    })()}
                  </td>
                  <td><StatusBadge status={u.active ? "running" : "stopped"} /></td>
                  <td className="text-xs text-slate-500">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}</td>
                  <td>
                    <div className="flex gap-2">
                      <Link to={`/users/${u.id}/permissions`} className="text-xs text-blue-400 underline">Permissions</Link>
                      <button
                        className="text-xs text-blue-400 underline"
                        onClick={() => {
                          setResetId(resetId === u.id ? null : u.id);
                          setResetPw({ a: "", b: "" });
                        }}
                      >
                        Reset password
                      </button>
                      <button
                        className="text-xs underline disabled:opacity-40 disabled:no-underline"
                        disabled={u.id === undefined || u.isInitialAdmin || (onlyAdmin && u.active)}
                        title={
                          u.isInitialAdmin
                            ? "The initial administrator cannot be disabled."
                            : onlyAdmin
                              ? "Cannot disable the only active administrator."
                              : undefined
                        }
                        onClick={() => void toggleActive(u.id, !u.active)}
                      >
                        {u.active ? "Disable" : "Enable"}
                      </button>
                      <button
                        className="text-xs text-red-300 underline disabled:opacity-40 disabled:no-underline"
                        disabled={deleteBlocked}
                        title={
                          u.isInitialAdmin
                            ? "The initial administrator cannot be deleted."
                            : onlyAdmin
                              ? "Cannot delete the only active administrator."
                              : undefined
                        }
                        onClick={() => void del(u.username, u.id)}
                      >
                        Delete
                      </button>
                    </div>
                    {resetId === u.id && (
                      <div className="flex flex-wrap gap-2 items-center mt-2">
                        <input
                          type="password"
                          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs w-44"
                          placeholder="New password (min 12, mixed case, number, symbol)"
                          value={resetPw.a}
                          onChange={(e) => setResetPw({ ...resetPw, a: e.target.value })}
                        />
                        <input
                          type="password"
                          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs w-44"
                          placeholder="Confirm new password"
                          value={resetPw.b}
                          onChange={(e) => setResetPw({ ...resetPw, b: e.target.value })}
                        />
                        <button
                          className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded"
                          disabled={!resetPw.a || resetPw.a !== resetPw.b}
                          title={resetPw.a && resetPw.a !== resetPw.b ? "Passwords do not match" : undefined}
                          onClick={() => void resetPassword(u.id, u.username)}
                        >
                          Set password
                        </button>
                        <span className="text-[11px] text-slate-500">Resets immediately and revokes their sessions.</span>
                      </div>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
