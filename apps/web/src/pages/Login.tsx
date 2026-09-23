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
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
      <form onSubmit={mode === "login" ? submit : submitRegister} className="bg-slate-900 border border-slate-800 rounded-lg p-8 w-96">
        <h1 className="text-2xl font-bold text-blue-400 mb-1">ProxVM</h1>
        <p className="text-xs text-slate-400 mb-4">
          Open-source virtual-machine management for Proxmox VE and Apache Guacamole.
        </p>
        <div className="space-y-3">
          <input
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <input
            type="password"
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === "register" && (
            <>
              <input
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm"
                placeholder="Email (optional)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <input
                type="password"
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm"
                placeholder="Confirm password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              <div className="bg-slate-800 border border-slate-700 rounded p-3 text-xs space-y-1">
                <div className="font-medium text-slate-300 mb-1">Password must have:</div>
                {PASSWORD_RULES.map((rule) => {
                  const ok = ruleMet(rule, password);
                  return (
                    <div key={rule.id} className={ok ? "text-green-300" : "text-slate-400"}>
                      {ok ? "✓" : "○"} {rule.label}
                    </div>
                  );
                })}
                <div className={password && password === confirm ? "text-green-300" : "text-slate-400"}>
                  {password && password === confirm ? "✓" : "○"} Passwords match
                </div>
              </div>
            </>
          )}
          {error && <div className="bg-red-900/50 border border-red-700 text-red-200 rounded p-2 text-sm">{error}</div>}
          {registered && (
            <div className="bg-green-900/50 border border-green-700 text-green-200 rounded p-2 text-sm">
              Request sent. An administrator must approve it before you can sign in.
            </div>
          )}
          <button
            disabled={busy || (mode === "register" && (!username || !rulesOk))}
            className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
          >
            {busy ? (mode === "login" ? "Signing in…" : "Sending…") : mode === "login" ? "Sign in" : "Request account"}
          </button>
          <button
            type="button"
            onClick={() => switchMode(mode === "login" ? "register" : "login")}
            className="w-full mt-2 text-xs text-blue-400 hover:underline"
          >
            {mode === "login" ? "No account? Request one" : "Have an account? Sign in"}
          </button>
          <div className="text-xs text-slate-500 mt-4 text-center">
            <a
              href="https://github.com/Bamoyski/ProxVM"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            >
              GitHub repository &amp; documentation
            </a>
          </div>
        </div>
      </form>
    </div>
  );
}