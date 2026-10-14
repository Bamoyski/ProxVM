import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, StatusBadge, ErrorBox, Empty, Section, Btn } from "../components/ui.js";

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
  const [quotaId, setQuotaId] = useState<string | null>(null);
  const [quotaVal, setQuotaVal] = useState("");
  const [quotaCurrent, setQuotaCurrent] = useState<string | null>(null);
  const [guacId, setGuacId] = useState<string | null>(null);
  const [guacPw, setGuacPw] = useState({ a: "", b: "" });
  const [guacStatus, setGuacStatus] = useState<{ guacUsername: string | null; directLoginEnabled: boolean; directLoginSetAt: string | null } | null>(null);
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
  const input = "pv-input";
  const label = "pv-label";

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

  const openQuota = async (id: string) => {
    setQuotaId(quotaId === id ? null : id);
    setQuotaCurrent(null);
    setQuotaVal("");
    if (quotaId !== id) {
      try {
        const res = await api<{ maxVms: number | null }>(`/users/${id}/quota`);
        setQuotaCurrent(res.maxVms === null ? "unlimited" : String(res.maxVms));
        if (res.maxVms !== null) setQuotaVal(String(res.maxVms));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const saveQuota = async (id: string, clear: boolean) => {
    setError(null);
    try {
      const maxVms = clear ? null : Number(quotaVal);
      if (!clear && (!Number.isInteger(maxVms) || (maxVms as number) < 0)) {
        setError("Quota must be a non-negative whole number (or Clear for unlimited).");
        return;
      }
      await api(`/users/${id}/quota`, { method: "PUT", body: { maxVms } });
      setQuotaId(null);
      setNotice("Quota updated. Limits apply to non-administrators at provision time.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  const openGuac = async (id: string) => {
    setGuacId(guacId === id ? null : id);
    setGuacPw({ a: "", b: "" });
    setGuacStatus(null);
    if (guacId !== id) {
      try {
        const res = await api<{ guacUsername: string | null; directLoginEnabled: boolean; directLoginSetAt: string | null }>(`/guacamole/users/${id}/direct-login`);
        setGuacStatus(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const saveGuac = async (id: string, username: string) => {
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ guacUsername: string }>(`/guacamole/users/${id}/direct-login`, {
        method: "POST",
        body: { password: guacPw.a },
      });
      setGuacId(null);
      setGuacPw({ a: "", b: "" });
      setNotice(`Direct Guacamole login enabled for ${username} (${res.guacUsername}). Share the password with them out-of-band — it is never shown again.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const disableGuac = async (id: string, username: string) => {
    if (!window.confirm(`Disable direct Guacamole login for ${username}? Their password rotates to a random unknown value (ProxVM launch keeps working).`)) return;
    setError(null);
    setNotice(null);
    try {
      await api(`/guacamole/users/${id}/direct-login`, { method: "DELETE" });
      setGuacId(null);
      setNotice(`Direct Guacamole login disabled for ${username}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const del = (username: string, id: string) => {    if (window.confirm(`Delete user ${username}? Their Guacamole account will also be removed.`)) {
      api(`/users/${id}`, { method: "DELETE" })
        .then(() => qc.invalidateQueries({ queryKey: ["users"] }))
        .catch((err) => alert(err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <div className="pv-page">
      <PageTitle title="Users" description="Accounts, roles, quotas, and pending registration requests." />
      {error && <ErrorBox error={error} />}
      {notice && (
        <div className="pv-notice pv-notice-ok">{notice}</div>
      )}
      {(requestsData?.requests ?? []).length > 0 && (
        <Section
          title={`Pending account requests (${requestsData?.requests.length})`}
          hint="Approving creates the account immediately with the chosen role."
        >
          {(requestsData?.requests ?? []).map((r) => (
            <div key={r.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}>
              <span>
                {r.username}
                {r.email && <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)", marginLeft: 4 }}>{r.email}</span>}
              </span>
              <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)" }}>requested {new Date(r.createdAt).toLocaleString()}</span>
              <select
                className="pv-select pv-input-auto"
                style={{ height: 28, fontSize: "0.78rem" }}
                value={approveRole[r.id] ?? "USER"}
                onChange={(e) => setApproveRole({ ...approveRole, [r.id]: e.target.value })}
              >
                {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <Btn size="sm" kind="primary" onClick={() => void decideRegistration(r.id, true)}>
                Approve
              </Btn>
              <Btn size="sm" kind="link" onClick={() => void decideRegistration(r.id, false)}>
                Reject
              </Btn>
            </div>
          ))}
        </Section>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-x-10">
        <Section title="Create user">
          <div className="pv-field">
            <label className="pv-label">Username</label>
            <input className={input} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </div>
          <div className="pv-field">
            <label className="pv-label">Email (optional)</label>
            <input className={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="pv-field">
            <label className="pv-label">Password</label>
            <input type="password" className={input} placeholder="Min 12, mixed case, number, symbol" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <div className="pv-field">
            <label className="pv-label">Role</label>
            <select className="pv-select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as (typeof ROLES)[number] })}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <Btn kind="primary" style={{ width: "100%" }} onClick={create} disabled={!form.username || !form.password}>
            Create user
          </Btn>
          <dl className="pv-kv" style={{ marginTop: 16 }}>
            <dt>ADMIN</dt><dd>everything</dd>
            <dt>OPERATOR</dt><dd>create/manage VMs, rotate credentials, access assigned connections</dd>
            <dt>USER</dt><dd>access assigned VMs, launch Guacamole</dd>
          </dl>
        </Section>
        <div className="lg:col-span-2">
          <Section title="Accounts" hint={`${(data?.users ?? []).length} total`}>
          <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Groups</th>
                <th>VMs</th>
                <th>Status</th>
                <th>Last login</th>
                <th>Actions</th>
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
                <tr key={u.id}>
                  <td>
                    {u.username}
                    {u.email && <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)", marginLeft: 4 }}>{u.email}</span>}
                    {u.isInitialAdmin && (
                      <span className="pv-mono" title="The initial administrator created during setup. Its role cannot be changed and it cannot be deleted." style={{ marginLeft: 6, color: "var(--pv-text-3)" }}>
                        initial admin
                      </span>
                    )}
                  </td>
                  <td>
                    <select
                      className="pv-select pv-input-auto"
                      style={{ height: 28, fontSize: "0.78rem" }}
                      value={u.roles[0] ?? "USER"}
                      disabled={roleLocked}
                      title={roleLocked ? "The initial administrator's role cannot be changed." : undefined}
                      onChange={(e) => void setRole(u.id, e.target.value)}
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td style={{ color: "var(--pv-text-2)" }}>
                    {(matrixByUser.get(u.id)?.groups ?? []).map((g) => g.name).join(", ") || "—"}
                  </td>
                  <td style={{ color: "var(--pv-text-2)" }}>
                    {(() => {
                      const info = matrixByUser.get(u.id);
                      if (!info) return "—";
                      const temp = info.vmAccess.filter((v) => v.expiresAt).length;
                      return `${info.vmAccess.length} VM${info.vmAccess.length === 1 ? "" : "s"}${temp ? ` (${temp} temporary)` : ""}`;
                    })()}
                  </td>
                  <td><StatusBadge status={u.active ? "running" : "stopped"} /></td>
                  <td style={{ color: "var(--pv-text-3)" }}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Link to={`/users/${u.id}/permissions`}>Permissions</Link>
                      <Btn
                        size="sm"
                        kind="link"
                        onClick={() => {
                          setResetId(resetId === u.id ? null : u.id);
                          setResetPw({ a: "", b: "" });
                        }}
                      >
                        Reset password
                      </Btn>
                      <Btn
                        size="sm"
                        kind="link"
                        onClick={() => void openQuota(u.id)}
                      >
                        Quota
                      </Btn>
                      <Btn
                        size="sm"
                        kind="link"
                        onClick={() => void openGuac(u.id)}
                      >
                        Guac login
                      </Btn>
                      <Btn
                        size="sm"
                        kind="link"
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
                      </Btn>
                      <Btn
                        size="sm"
                        kind="link"
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
                      </Btn>
                    </div>
                    {resetId === u.id && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 }}>
                        <input
                          type="password"
                          className="pv-input"
                          style={{ width: 176 }}
                          placeholder="New password"
                          value={resetPw.a}
                          onChange={(e) => setResetPw({ ...resetPw, a: e.target.value })}
                        />
                        <input
                          type="password"
                          className="pv-input"
                          style={{ width: 176 }}
                          placeholder="Confirm new password"
                          value={resetPw.b}
                          onChange={(e) => setResetPw({ ...resetPw, b: e.target.value })}
                        />
                        <Btn
                          size="sm"
                          kind="primary"
                          disabled={!resetPw.a || resetPw.a !== resetPw.b}
                          title={resetPw.a && resetPw.a !== resetPw.b ? "Passwords do not match" : undefined}
                          onClick={() => void resetPassword(u.id, u.username)}
                        >
                          Set password
                        </Btn>
                        <span className="pv-hint">Resets immediately and revokes their sessions.</span>
                      </div>
                    )}
                    {quotaId === u.id && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 }}>
                        <span className="pv-hint">Current: {quotaCurrent ?? "…"}</span>
                        <input
                          className="pv-input"
                          style={{ width: 112 }}
                          placeholder="Max VMs"
                          inputMode="numeric"
                          value={quotaVal}
                          onChange={(e) => setQuotaVal(e.target.value)}
                        />
                        <Btn
                          size="sm"
                          kind="primary"
                          onClick={() => void saveQuota(u.id, false)}
                        >
                          Set quota
                        </Btn>
                        <Btn
                          size="sm"
                          onClick={() => void saveQuota(u.id, true)}
                        >
                          Clear
                        </Btn>
                      </div>
                    )}
                    {guacId === u.id && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 }}>
                        <span className="pv-hint">
                          {guacStatus
                            ? guacStatus.guacUsername
                              ? `${guacStatus.guacUsername}: direct login ${guacStatus.directLoginEnabled ? `ON${guacStatus.directLoginSetAt ? ` (set ${new Date(guacStatus.directLoginSetAt).toLocaleString()})` : ""}` : "off"}`
                              : "No Guacamole account yet (created on enable)."
                            : "…"}
                        </span>
                        <input
                          type="password"
                          className="pv-input"
                          style={{ width: 176 }}
                          placeholder="New Guac password"
                          title="Min 12, mixed case, number, symbol"
                          value={guacPw.a}
                          onChange={(e) => setGuacPw({ ...guacPw, a: e.target.value })}
                        />
                        <input
                          type="password"
                          className="pv-input"
                          style={{ width: 176 }}
                          placeholder="Confirm Guac password"
                          value={guacPw.b}
                          onChange={(e) => setGuacPw({ ...guacPw, b: e.target.value })}
                        />
                        <Btn
                          size="sm"
                          kind="primary"
                          disabled={!guacPw.a || guacPw.a !== guacPw.b}
                          title={guacPw.a && guacPw.a !== guacPw.b ? "Passwords do not match" : undefined}
                          onClick={() => void saveGuac(u.id, u.username)}
                        >
                          Enable direct login
                        </Btn>
                        <Btn
                          size="sm"
                          onClick={() => void disableGuac(u.id, u.username)}
                        >
                          Disable
                        </Btn>
                        <span className="pv-hint">Write-only: share it out-of-band, it is never shown again. Direct sessions bypass ProxVM launch audit.</span>
                      </div>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
