import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setCsrfToken } from "../api.js";

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
      <form onSubmit={submit} className="bg-slate-900 border border-slate-800 rounded-lg p-8 w-96">
        <h1 className="text-2xl font-bold text-blue-400 mb-6">ProxVM</h1>
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
          {error && <div className="bg-red-900/50 border border-red-700 text-red-200 rounded p-2 text-sm">{error}</div>}
          <button disabled={busy} className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}