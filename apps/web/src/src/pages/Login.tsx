import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setCsrfToken } from "../api.js";
import { PASSWORD_RULES } from "@proxvm/shared";

function ruleMet(rule: (typeof PASSWORD_RULES)[number], password: string): boolean {
  if (rule.minLength !== null) return password.length >= rule.minLength;
  return rule.test !== null && rule.test.test(password);
}

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState("");
  const [registered, setRegistered] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ csrfToken: string }>("/auth/login", { method: "POST", body: { username, password } });
      setCsrfToken(res.csrfToken);
      navigate("/");
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/register", { method: "POST", body: { username, email: email || undefined, password } });
      setRegistered(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: "login" | "register"): void => {
    setMode(next);
    setError(null);
    setRegistered(false);
    setConfirm("");
  };

  const rulesOk = PASSWORD_RULES.every((r) => ruleMet(r, password)) && password === confirm && password.length > 0;

  return (
    <div className="pv-shell" style={{ alignItems: "center", justifyContent: "center" }}>
      <form onSubmit={mode === "login" ? submit : submitRegister} className="pv-panel" style={{ width: 380, maxWidth: "calc(100vw - 32px)" }}>
        <div className="pv-brand" style={{ padding: "0 0 2px" }}>Prox<b>VM</b></div>
        <p className="pv-sub" style={{ marginBottom: 18 }}>
          {mode === "login"
            ? "Sign in to manage virtual machines."
            : "Request an account. An administrator approves every request."}
        </p>
        <div className="pv-field">
          <label className="pv-label" htmlFor="login-username">Username</label>
          <input
            id="login-username"
            className="pv-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </div>
        <div className="pv-field">
          <label className="pv-label" htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            className="pv-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </div>
        {mode === "register" && (
          <>
            <div className="pv-field">
              <label className="pv-label" htmlFor="login-email">Email <span style={{ fontWeight: 400 }}>(optional)</span></label>
              <input
                id="login-email"
                className="pv-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div className="pv-field">
              <label className="pv-label" htmlFor="login-confirm">Confirm password</label>
              <input
                id="login-confirm"
                type="password"
                className="pv-input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="pv-panel" style={{ padding: "10px 12px", marginBottom: 12, background: "var(--pv-inset)" }}>
              <div className="pv-label" style={{ marginBottom: 6 }}>Password must have</div>
              {PASSWORD_RULES.map((rule) => {
                const ok = ruleMet(rule, password);
                return (
                  <div key={rule.id} style={{ fontSize: "0.8rem", color: ok ? "var(--pv-ok)" : "var(--pv-text-3)" }}>
                    {ok ? "✓" : "○"} {rule.label}
                  </div>
                );
              })}
              <div style={{ fontSize: "0.8rem", color: password && password === confirm ? "var(--pv-ok)" : "var(--pv-text-3)" }}>
                {password && password === confirm ? "✓" : "○"} Passwords match
              </div>
            </div>
          </>
        )}
        {error && <div className="pv-error">{error}</div>}
        {registered && (
          <div className="pv-notice pv-notice-ok">Request sent. An administrator must approve it before you can sign in.</div>
        )}
        <button
          disabled={busy || (mode === "register" && (!username || !rulesOk))}
          className="pv-btn pv-btn-primary"
          style={{ width: "100%", marginBottom: 10 }}
        >
          {busy ? (mode === "login" ? "Signing in…" : "Sending…") : mode === "login" ? "Sign in" : "Request account"}
        </button>
        <button type="button" onClick={() => switchMode(mode === "login" ? "register" : "login")} className="pv-btn pv-btn-link" style={{ width: "100%", fontSize: "0.8rem" }}>
          {mode === "login" ? "No account? Request one" : "Have an account? Sign in"}
        </button>
        <div style={{ fontSize: "0.76rem", color: "var(--pv-text-3)", marginTop: 16, textAlign: "center" }}>
          <a href="https://github.com/Bamoyski/ProxVM" target="_blank" rel="noopener noreferrer">
            GitHub repository &amp; documentation
          </a>
          <div style={{ marginTop: 2 }}>by bamoyskistudios</div>
        </div>
      </form>
    </div>
  );
}
