import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { fmtDateTime } from "../lib/format.js";
import {
  PageHeader, StatusBadge, Section, Btn, Alert, Field, Input, Select,
  useConfirm, useToast, errText,
} from "../ui/index.js";

const ROLES = ["ADMIN", "OPERATOR", "USER"] as const;

/** User administration: accounts, roles, quotas, Guac direct login, requests. */
export default function Users() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => api<{ users: Array<{ id: string; username: string; email: string | null; roles: string[]; active: boolean; isInitialAdmin: boolean; createdAt: string; lastLoginAt: string | null }> }>("/users"),
  });
  const [form, setForm] = useState({ username: "", email: "", password: "", role: "USER" as (typeof ROLES)[number] });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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
    retry: false,
  });
  const matrixByUser = new Map((matrix?.users ?? []).map((m) => [m.user.id, m] as const));

  const create = async () => {
    if (creating) return;
    setError(null);
    setNotice(null);
    setCreating(true);
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
      } else {
        toast.ok("User created", `${res.user.username} · role ${form.role}`);
      }
      void qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setError(errText(err));
    } finally {
      setCreating(false);
    }
  };

  const setRole = async (id: string, role: string) => {
    try {
      await api(`/users/${id}`, { method: "PUT", body: { role } });
      toast.info("Role changed", `Now ${role}.`);
      void qc.invalidateQueries({ queryKey: ["users"] });
      void qc.invalidateQueries({ queryKey: ["iam-effective"] });
    } catch (err) {
      toast.err("Role change failed", errText(err));
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
        setError(errText(err));
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
      setError(errText(err));
    }
  };

  const toggleActive = async (id: string, active: boolean) => {
    try {
      await api(`/users/${id}`, { method: "PUT", body: { active } });
      toast.info(active ? "Account enabled" : "Account disabled");
      void qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      toast.err("State change failed", errText(err));
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
      setError(errText(err));
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
      setError(errText(err));
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
        setError(errText(err));
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
      setError(errText(err));
    }
  };

  const disableGuac = async (id: string, username: string) => {
    const ok = await confirm({
      title: `Disable direct Guacamole login for ${username}?`,
      danger: true,
      confirmLabel: "Disable direct login",
      body: "Their password rotates to a random unknown value. ProxVM launches keep working; direct Guacamole sign-in stops.",
    });
    if (!ok) return;
    setError(null);
    setNotice(null);
    try {
      await api(`/guacamole/users/${id}/direct-login`, { method: "DELETE" });
      setGuacId(null);
      setNotice(`Direct Guacamole login disabled for ${username}.`);
    } catch (err) {
      setError(errText(err));
    }
  };

  const del = async (username: string, id: string) => {
    const ok = await confirm({
      title: `Delete user ${username}?`,
      danger: true,
      requireText: `DELETE ${username}`,
      confirmLabel: "Delete user",
      body: "Their Guacamole account is also removed, along with direct grants. Group-derived access stays until the groups change.",
    });
    if (!ok) return;
    try {
      await api(`/users/${id}`, { method: "DELETE" });
      toast.ok("User deleted", username);
      void qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      toast.err("Delete failed", errText(err));
    }
  };

  return (
    <div className="pv-page">
      <PageHeader title="Users" description="Accounts, roles, quotas, and pending registration requests." />
      {error && <Alert kind="err" title="Action failed">{error}</Alert>}
      {notice && <Alert kind="ok" title="Done">{notice}</Alert>}

      {(requestsData?.requests ?? []).length > 0 && (
        <Section
          title={`Pending account requests (${requestsData?.requests.length})`}
          hint="Approving creates the account immediately with the chosen role."
        >
          {(requestsData?.requests ?? []).map((r) => (
            <div
              key={r.id}
              style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--pv-border-soft)", fontSize: "0.85rem" }}
            >
              <span>
                {r.username}
                {r.email && <span className="pv-faint" style={{ fontSize: "0.76rem", marginLeft: 4 }}>{r.email}</span>}
              </span>
              <span className="pv-faint" style={{ fontSize: "0.76rem" }}>requested {fmtDateTime(r.createdAt)}</span>
              <Select
                autoWidth
                small
                value={approveRole[r.id] ?? "USER"}
                onChange={(e) => setApproveRole({ ...approveRole, [r.id]: e.target.value })}
                aria-label={`Role to grant ${r.username}`}
              >
                {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </Select>
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

      <div className="pv-grid-2">
        <Section title="Create user" hint="New accounts start with the selected role and no VM access until granted.">
          <Field label="Username" required>
            {({ id }) => <Input id={id} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />}
          </Field>
          <Field label="Email (optional)" hint="Not used for delivery — shown for identification.">
            {({ id }) => <Input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
          </Field>
          <Field label="Password" required hint="Min 12 characters with mixed case, number, and symbol.">
            {({ id }) => (
              <Input id={id} type="password" placeholder="Min 12, mixed case, number, symbol" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
            )}
          </Field>
          <Field label="Role">
            {({ id }) => (
              <Select id={id} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as (typeof ROLES)[number] })}>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            )}
          </Field>
          <Btn kind="primary" style={{ width: "100%" }} loading={creating} onClick={() => void create()} disabled={!form.username || !form.password}>
            Create user
          </Btn>
          <dl className="pv-kv" style={{ marginTop: 16 }}>
            <dt>ADMIN</dt><dd>everything</dd>
            <dt>OPERATOR</dt><dd>create/manage VMs, rotate credentials, access assigned connections</dd>
            <dt>USER</dt><dd>access assigned VMs, launch Guacamole</dd>
          </dl>
        </Section>

        <Section title="Accounts" hint={`${(data?.users ?? []).length} total`}>
          <div className="pv-table-wrap">
            <table className="pv-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th className="pv-hide-sm">Groups</th>
                  <th className="pv-hide-md">VMs</th>
                  <th>Status</th>
                  <th className="pv-hide-md">Last login</th>
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
                        <span style={{ fontWeight: 550 }}>{u.username}</span>
                        {u.email && <span className="pv-faint" style={{ fontSize: "0.76rem", marginLeft: 4 }}>{u.email}</span>}
                        {u.isInitialAdmin && (
                          <span
                            className="pv-faint pv-mono"
                            title="The initial administrator created during setup. Its role cannot be changed and it cannot be deleted."
                            style={{ marginLeft: 6, fontSize: "0.72rem" }}
                          >
                            initial admin
                          </span>
                        )}
                      </td>
                      <td>
                        <Select
                          autoWidth
                          small
                          value={u.roles[0] ?? "USER"}
                          disabled={roleLocked}
                          title={roleLocked ? "The initial administrator's role cannot be changed." : undefined}
                          onChange={(e) => void setRole(u.id, e.target.value)}
                          aria-label={`Role for ${u.username}`}
                        >
                          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </Select>
                      </td>
                      <td className="pv-hide-sm" style={{ color: "var(--pv-text-2)" }}>
                        {(matrixByUser.get(u.id)?.groups ?? []).map((g) => g.name).join(", ") || "—"}
                      </td>
                      <td className="pv-hide-md" style={{ color: "var(--pv-text-2)" }}>
                        {(() => {
                          const info = matrixByUser.get(u.id);
                          if (!info) return "—";
                          const temp = info.vmAccess.filter((v) => v.expiresAt).length;
                          return `${info.vmAccess.length} VM${info.vmAccess.length === 1 ? "" : "s"}${temp ? ` (${temp} temporary)` : ""}`;
                        })()}
                      </td>
                      <td><StatusBadge status={u.active ? "running" : "stopped"} /></td>
                      <td className="pv-faint pv-hide-md">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "never"}</td>
                      <td>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <Link to={`/users/${u.id}/permissions`} className="pv-link-target" style={{ fontSize: "0.8rem" }}>Permissions</Link>
                          <Btn size="sm" kind="link" onClick={() => { setResetId(resetId === u.id ? null : u.id); setResetPw({ a: "", b: "" }); }}>
                            Reset password
                          </Btn>
                          <Btn size="sm" kind="link" onClick={() => void openQuota(u.id)}>Quota</Btn>
                          <Btn size="sm" kind="link" onClick={() => void openGuac(u.id)}>Guac login</Btn>
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
                            <Input
                              type="password"
                              small
                              style={{ width: 176 }}
                              placeholder="New password"
                              aria-label="New password"
                              value={resetPw.a}
                              onChange={(e) => setResetPw({ ...resetPw, a: e.target.value })}
                            />
                            <Input
                              type="password"
                              small
                              style={{ width: 176 }}
                              placeholder="Confirm new password"
                              aria-label="Confirm new password"
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
                            <Input
                              small
                              style={{ width: 112 }}
                              placeholder="Max VMs"
                              inputMode="numeric"
                              aria-label="Max VMs"
                              value={quotaVal}
                              onChange={(e) => setQuotaVal(e.target.value)}
                            />
                            <Btn size="sm" kind="primary" onClick={() => void saveQuota(u.id, false)}>Set quota</Btn>
                            <Btn size="sm" onClick={() => void saveQuota(u.id, true)}>Clear</Btn>
                          </div>
                        )}
                        {guacId === u.id && (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 }}>
                            <span className="pv-hint">
                              {guacStatus
                                ? guacStatus.guacUsername
                                  ? `${guacStatus.guacUsername}: direct login ${guacStatus.directLoginEnabled ? `ON${guacStatus.directLoginSetAt ? ` (set ${fmtDateTime(guacStatus.directLoginSetAt)})` : ""}` : "off"}`
                                  : "No Guacamole account yet (created on enable)."
                                : "…"}
                            </span>
                            <Input
                              type="password"
                              small
                              style={{ width: 176 }}
                              placeholder="New Guac password"
                              title="Min 12, mixed case, number, symbol"
                              aria-label="New Guacamole password"
                              value={guacPw.a}
                              onChange={(e) => setGuacPw({ ...guacPw, a: e.target.value })}
                            />
                            <Input
                              type="password"
                              small
                              style={{ width: 176 }}
                              placeholder="Confirm Guac password"
                              aria-label="Confirm Guacamole password"
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
                            <Btn size="sm" onClick={() => void disableGuac(u.id, u.username)}>Disable</Btn>
                            <span className="pv-hint" style={{ flexBasis: "100%" }}>
                              Write-only: share it out-of-band, it is never shown again. Direct sessions bypass
                              ProxVM launch audit. If changed inside Guacamole itself, ProxVM launch breaks until
                              re-set here.
                            </span>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {isLoading && !data && <div className="pv-faint" style={{ fontSize: "0.85rem", padding: "12px 0" }}>Loading accounts…</div>}
          {data && !data.users.length && (
            <div className="pv-faint" style={{ fontSize: "0.85rem", padding: "12px 0" }}>No accounts yet — create the first one on the left.</div>
          )}
        </Section>
      </div>
    </div>
  );
}
