import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setCsrfToken } from "../api.js";
import { PASSWORD_RULES, TURNSTILE_SIGNUP_ACTION } from "@proxvm/shared";

// The public signup shape: mode + the Turnstile SITE key (public by design;
// the server's secret never reaches the browser).
interface RegisterConfig {
  mode: "closed" | "approval" | "auto";
  turnstileSiteKey: string | null;
}

declare global {
  interface Window {
    turnstile?: {
      getResponse: (widgetId?: string) => string;
      reset: (widgetId?: string) => void;
    };
  }
}

function ruleMet(rule: (typeof PASSWORD_RULES)[number], password: string): boolean {
  if (rule.minLength !== null) return password.length >= rule.minLength;
  if (rule.maxLength !== null) return password.length <= rule.maxLength;
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
  const [cfg, setCfg] = useState<RegisterConfig | null>(null);

  // Public fetch; fail-open (form as before, backend still enforces authoritatively).
  useEffect(() => {
    api<RegisterConfig>("/auth/register-config")
      .then(setCfg)
      .catch(() => setCfg(null));
  }, []);

  // Load the Turnstile script once the register form (may) need it.
  useEffect(() => {
    if (!cfg?.turnstileSiteKey) return;
    if (document.getElementById("cf-turnstile-api")) return;
    const script = document.createElement("script");
    script.id = "cf-turnstile-api";
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    document.head.appendChild(script);
  }, [cfg?.turnstileSiteKey]);

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
    // Serve-side demand (bot gate): if the widget exists, the implicit token
    // is mandatory before we even hit the network.
    let token: string | undefined;
    if (cfg?.turnstileSiteKey) {
      token = window.turnstile?.getResponse?.() || undefined;
      if (!token) {
        setBusy(false);
        setError("Please complete the verification challenge.");
        return;
      }
    }
    try {
      await api("/auth/register", { method: "POST", body: { username, email: email || undefined, password, turnstileToken: token } });
      setRegistered(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Turnstile tokens are single-use: a failed attempt must start over,
      // or every retry would re-post the spent token and forever fail.
      try {
        window.turnstile?.reset?.();
      } catch {
        // widget not loaded; nothing to reset
      }
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
  const registrationClosed = cfg?.mode === "closed";
  const autoApprove = cfg?.mode === "auto";

  return (
    <div className="pv-shell" style={{ alignItems: "center", justifyContent: "center" }}>
      <form onSubmit={mode === "login" ? submit : submitRegister} className="pv-panel" style={{ width: 380, maxWidth: "calc(100vw - 32px)" }}>
        <h1 className="pv-brand" style={{ padding: "0 0 2px" }}>Prox<b>VM</b></h1>
        <p className="pv-sub" style={{ marginBottom: 18 }}>
          {mode === "login"
            ? "Sign in to manage virtual machines."
            : autoApprove
              ? "Create an account and get in. An administrator grants VM access."
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
            {cfg?.turnstileSiteKey && (
              <div style={{ marginBottom: 12, display: "flex", justifyContent: "center" }}>
                <div
                  className="cf-turnstile"
                  data-sitekey={cfg.turnstileSiteKey}
                  data-action={TURNSTILE_SIGNUP_ACTION}
                />
              </div>
            )}
          </>
        )}
        {error && <div className="pv-error">{error}</div>}
        {registered && (
          <div className="pv-alert pv-alert-ok">
            {autoApprove
              ? "Account created! Sign in to get started — VM access is granted by an administrator."
              : "Request sent. An administrator must approve it before you can sign in."}
          </div>
        )}
        <button
          disabled={busy || (mode === "register" && (!username || !rulesOk))}
          className="pv-btn pv-btn-primary"
          style={{ width: "100%", marginBottom: 10 }}
        >
          {busy ? (mode === "login" ? "Signing in…" : "Sending…") : mode === "login" ? "Sign in" : autoApprove ? "Create account" : "Request account"}
        </button>
        {!registrationClosed && (
          <button type="button" onClick={() => switchMode(mode === "login" ? "register" : "login")} className="pv-btn pv-btn-link" style={{ width: "100%", fontSize: "0.8rem" }}>
            {mode === "login" ? "No account? Request one" : "Have an account? Sign in"}
          </button>
        )}
        {registrationClosed && mode === "register" && (
          <button type="button" onClick={() => switchMode("login")} className="pv-btn pv-btn-link" style={{ width: "100%", fontSize: "0.8rem" }}>
            Have an account? Sign in
          </button>
        )}
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
