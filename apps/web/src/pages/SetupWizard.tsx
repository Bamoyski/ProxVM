import { useState } from "react";
import { api } from "../api.js";

const STEPS = [
  "Create administrator",
  "Configure Proxmox",
  "Test Proxmox",
  "Configure Guacamole",
  "Test Guacamole",
  "Configure database",
  "Encryption & finalize",
  "Enter dashboard",
];

export default function SetupWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, unknown> | null>(null);

  const [admin, setAdmin] = useState({ username: "admin", password: "", email: "" });
  const [proxmox, setProxmox] = useState({
    url: "https://pve.example.local:8006",
    tokenId: "root@pam!proxvm",
    tokenSecret: "",
    verifySsl: false,
    defaultNode: "",
    defaultStorage: "",
    defaultNetwork: "",
  });
  const [guacamole, setGuacamole] = useState({
    dbEngine: "mariadb" as "postgresql" | "mariadb" | "mysql",
    url: "http://guacamole.example.local:8080/guacamole",
    publicUrl: "",
    dbHost: "",
    dbPort: 3306,
    dbName: "guacamole_db",
    dbUser: "guacamole",
    dbPassword: "",
    dbSsl: false,
  });
  const [database, setDatabase] = useState({ host: "127.0.0.1", port: 5432, name: "proxvm", user: "proxvm", password: "", ssl: false });
  const [redis, setRedis] = useState({ host: "127.0.0.1", port: 6379, password: "", db: 0 });

  const input = "w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm";
  const label = "block text-xs font-medium text-slate-400 mb-1";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const testProxmox = () =>
    run(async () => {
      const res = await api<{ ok: boolean; error?: string; version?: string; nodes?: Array<{ node: string; online: boolean }> }>(
        "/setup/test-proxmox",
        { method: "POST", body: proxmox },
      );
      if (!res.ok) throw new Error(res.error ?? "Proxmox test failed");
      setTestResult(`Connected to Proxmox ${res.version} — nodes: ${res.nodes?.map((n) => n.node).join(", ")}`);
    });

  const testGuacamole = () =>
    run(async () => {
      const res = await api<{ ok: boolean; error?: string; schemaVersion?: string | null; webReachable?: boolean | null; webDetail?: string | null }>(
        "/setup/test-guacamole",
        { method: "POST", body: guacamole },
      );
      if (!res.ok) throw new Error(res.error ?? "Guacamole database test failed");
      setTestResult(
        `Guacamole DB OK${res.schemaVersion ? ` (schema ${res.schemaVersion})` : ""}. Web app: ${res.webReachable ? "reachable" : `NOT reachable (${res.webDetail ?? "unknown"})`}`,
      );
    });

  const testDatabase = () =>
    run(async () => {
      const res = await api<{ ok: boolean; error?: string; serverVersion?: string }>("/setup/test-database", {
        method: "POST",
        body: database,
      });
      if (!res.ok) throw new Error(res.error ?? "Database test failed");
      setTestResult(`Connected to PostgreSQL ${res.serverVersion ?? ""}`);
    });

  const testRedis = () =>
    run(async () => {
      const res = await api<{ ok: boolean; host?: string; port?: number; error?: string }>("/setup/test-redis", {
        method: "POST",
        body: { host: redis.host, port: redis.port, password: redis.password || undefined, db: redis.db },
      });
      if (!res.ok) throw new Error(res.error ?? "Redis test failed");
      setTestResult(`Connected to Redis at ${res.host}:${res.port}`);
    });

  const finalize = () =>
    run(async () => {
      const res = await api<{ ok: boolean; checks: Record<string, unknown> }>("/setup/complete", {
        method: "POST",
        body: {
          admin: {
            username: admin.username,
            email: admin.email || undefined,
            password: admin.password,
            sessionDurationHours: 12,
            sessionIdleTimeoutMinutes: 120,
            cookieSecure: window.location.protocol === "https:",
          },
          database,
          redis: { host: redis.host, port: redis.port, password: redis.password || undefined, db: redis.db },
          proxmox,
          guacamole,
        },
      });
      setChecks(res.checks);
      setStep(8);
    });

  function Nav({ onNext, nextLabel, back = true }: { onNext: () => void; nextLabel: string; back?: boolean }) {
    return (
      <div className="flex justify-between mt-6">
        <button
          onClick={() => setStep((s) => Math.max(1, s - 1))}
          className={`px-4 py-2 rounded text-sm ${back ? "bg-slate-800 hover:bg-slate-700" : "invisible"}`}
        >
          Back
        </button>
        <button onClick={onNext} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm">
          {nextLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <h1 className="text-3xl font-bold text-blue-400 mb-2">ProxVM Setup</h1>
        <p className="text-slate-400 mb-6">Configure your real Proxmox and Guacamole infrastructure.</p>
        <ol className="flex flex-wrap gap-1 mb-6">
          {STEPS.map((s, i) => (
            <li key={s} className={`px-2 py-1 rounded text-xs ${i + 1 === step ? "bg-blue-600 text-white" : i + 1 < step ? "bg-green-800 text-green-200" : "bg-slate-800 text-slate-400"}`}>
              {i + 1}. {s}
            </li>
          ))}
        </ol>

        <div className="bg-slate-900 border border-slate-800 rounded p-6">
          {step === 1 && (
            <>
              <h2 className="text-lg font-semibold mb-4">Step 1 — Create administrator</h2>
              <div className="space-y-3">
                <Field label="Username">
                  <input className={input} value={admin.username} onChange={(e) => setAdmin({ ...admin, username: e.target.value })} />
                </Field>
                <Field label="Email (optional)">
                  <input className={input} value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} />
                </Field>
                <Field label="Password (min 12 chars, upper/lower/number/symbol)">
                  <input type="password" className={input} value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} />
                </Field>
              </div>
              <Nav onNext={() => setStep(2)} nextLabel="Next: Proxmox" />
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="text-lg font-semibold mb-4">Step 2 — Configure Proxmox</h2>
              <div className="space-y-3">
                <Field label="Proxmox URL">
                  <input className={input} value={proxmox.url} onChange={(e) => setProxmox({ ...proxmox, url: e.target.value })} />
                </Field>
                <Field label="API Token ID (e.g. root@pam!proxvm)">
                  <input className={input} value={proxmox.tokenId} onChange={(e) => setProxmox({ ...proxmox, tokenId: e.target.value })} />
                </Field>
                <Field label="API Token secret">
                  <input type="password" className={input} value={proxmox.tokenSecret} onChange={(e) => setProxmox({ ...proxmox, tokenSecret: e.target.value })} />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={proxmox.verifySsl} onChange={(e) => setProxmox({ ...proxmox, verifySsl: e.target.checked })} />
                  Verify SSL certificate (disable for self-signed certificates)
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Default node"><input className={input} value={proxmox.defaultNode} onChange={(e) => setProxmox({ ...proxmox, defaultNode: e.target.value })} /></Field>
                  <Field label="Default storage"><input className={input} value={proxmox.defaultStorage} onChange={(e) => setProxmox({ ...proxmox, defaultStorage: e.target.value })} /></Field>
                  <Field label="Default bridge"><input className={input} value={proxmox.defaultNetwork} onChange={(e) => setProxmox({ ...proxmox, defaultNetwork: e.target.value })} /></Field>
                </div>
              </div>
              <Nav onNext={() => setStep(3)} nextLabel="Next: Test connection" />
            </>
          )}

          {step === 3 && (
            <>
              <h2 className="text-lg font-semibold mb-4">Step 3 — Test Proxmox connection</h2>
              <p className="text-sm text-slate-400 mb-4">Performs a real API call to your Proxmox server.</p>
              <button onClick={testProxmox} disabled={busy} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm">
                {busy ? "Testing…" : "Test connection"}
              </button>
              {testResult && <div className="mt-3 bg-green-900/40 border border-green-700 text-green-200 rounded p-3 text-sm">{testResult}</div>}
              <Nav onNext={() => setStep(4)} nextLabel="Next: Guacamole" />
            </>
          )}

          {step === 4 && (
            <>
              <h2 className="text-lg font-semibold mb-4">Step 4 — Configure Guacamole</h2>
              <div className="space-y-3">
                <Field label="Database engine">
                  <select
                    className={input}
                    value={guacamole.dbEngine}
                    onChange={(e) => {
                      const engine = e.target.value as "postgresql" | "mariadb" | "mysql";
                      setGuacamole({ ...guacamole, dbEngine: engine, dbPort: engine === "postgresql" ? 5432 : 3306 });
                    }}
                  >
                    <option value="mariadb">MariaDB</option>
                    <option value="mysql">MySQL</option>
                    <option value="postgresql">PostgreSQL</option>
                  </select>
                </Field>
                <Field label="Guacamole URL">
                  <input className={input} value={guacamole.url} onChange={(e) => setGuacamole({ ...guacamole, url: e.target.value })} />
                </Field>
                <Field label="Public URL (for browser access, e.g. https://guacamole.example.com/guacamole/)">
                  <input className={input} value={guacamole.publicUrl} onChange={(e) => setGuacamole({ ...guacamole, publicUrl: e.target.value })} placeholder="Leave empty to use the URL above" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Database host"><input className={input} value={guacamole.dbHost} onChange={(e) => setGuacamole({ ...guacamole, dbHost: e.target.value })} /></Field>
                  <Field label="Database port"><input type="number" className={input} value={guacamole.dbPort} onChange={(e) => setGuacamole({ ...guacamole, dbPort: Number(e.target.value) })} /></Field>
                </div>
                <Field label="Database name"><input className={input} value={guacamole.dbName} onChange={(e) => setGuacamole({ ...guacamole, dbName: e.target.value })} /></Field>
                <Field label="Database user"><input className={input} value={guacamole.dbUser} onChange={(e) => setGuacamole({ ...guacamole, dbUser: e.target.value })} /></Field>
                <Field label="Database password"><input type="password" className={input} value={guacamole.dbPassword} onChange={(e) => setGuacamole({ ...guacamole, dbPassword: e.target.value })} /></Field>
              </div>
              <Nav onNext={() => setStep(5)} nextLabel="Next: Test connection" />
            </>
          )}

          {step === 5 && (
            <>
              <h2 className="text-lg font-semibold mb-4">Step 5 — Test Guacamole connection</h2>
              <p className="text-sm text-slate-400 mb-4">Real database connection + schema check, plus Guacamole web app reachability.</p>
              <button onClick={testGuacamole} disabled={busy} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm">
                {busy ? "Testing…" : "Test connection"}
              </button>
              {testResult && <div className="mt-3 bg-slate-800 border border-slate-700 rounded p-3 text-sm">{testResult}</div>}
              <Nav onNext={() => setStep(6)} nextLabel="Next: Database" />
            </>
          )}

          {step === 6 && (
            <>
              <h2 className="text-lg font-semibold mb-4">Step 6 — Application database & Redis</h2>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="PostgreSQL host"><input className={input} value={database.host} onChange={(e) => setDatabase({ ...database, host: e.target.value })} /></Field>
                  <Field label="Port"><input type="number" className={input} value={database.port} onChange={(e) => setDatabase({ ...database, port: Number(e.target.value) })} /></Field>
                </div>
                <Field label="Database name"><input className={input} value={database.name} onChange={(e) => setDatabase({ ...database, name: e.target.value })} /></Field>
                <Field label="Database user"><input className={input} value={database.user} onChange={(e) => setDatabase({ ...database, user: e.target.value })} /></Field>
                <Field label="Database password"><input type="password" className={input} value={database.password} onChange={(e) => setDatabase({ ...database, password: e.target.value })} /></Field>
                <hr className="border-slate-800" />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Redis host"><input className={input} value={redis.host} onChange={(e) => setRedis({ ...redis, host: e.target.value })} /></Field>
                  <Field label="Redis port"><input type="number" className={input} value={redis.port} onChange={(e) => setRedis({ ...redis, port: Number(e.target.value) })} /></Field>
                </div>
              </div>
              <div className="flex justify-between mt-6">
                <button onClick={() => setStep(5)} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded text-sm">Back</button>
                <div className="flex gap-2">
                  <button onClick={testDatabase} disabled={busy} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm">
                    {busy ? "Testing…" : "Test database"}
                  </button>
                  <button onClick={testRedis} disabled={busy} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm">
                    {busy ? "Testing…" : "Test Redis"}
                  </button>
                  <button onClick={() => setStep(7)} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded text-sm">Next: Encryption</button>
                </div>
              </div>
              {testResult && <div className="mt-3 bg-slate-800 border border-slate-700 rounded p-3 text-sm">{testResult}</div>}
            </>
          )}

          {step === 7 && (
            <>
              <h2 className="text-lg font-semibold mb-4">Step 7 — Initialize encryption & finalize</h2>
              <p className="text-sm text-slate-400 mb-4">
                A master encryption key (AES-256-GCM) and session signing key are generated securely and stored server-side in{" "}
                <span className="font-mono">.proxvm/config.json</span>. VM passwords and infrastructure secrets are encrypted with the master key.
              </p>
              <p className="text-sm text-slate-400 mb-4">
                Finalizing connects to PostgreSQL and Redis for real, runs migrations, creates the administrator, stores your
                Proxmox/Guacamole configuration (encrypted), and runs real integration checks.
              </p>
              <button onClick={finalize} disabled={busy} className="px-4 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 rounded text-sm">
                {busy ? "Initializing…" : "Initialize and run integration checks"}
              </button>
              <div className="flex justify-start mt-6">
                <button onClick={() => setStep(6)} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded text-sm">Back</button>
              </div>
            </>
          )}

          {step === 8 && (
            <>
              <h2 className="text-lg font-semibold mb-4">Step 8 — Integration checks</h2>
              <pre className="bg-slate-800 rounded p-3 text-xs overflow-auto mb-4">{JSON.stringify(checks, null, 2)}</pre>
              <button
                onClick={() => {
                  onDone();
                  window.location.href = "/login";
                }}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm"
              >
                Enter dashboard
              </button>
            </>
          )}

          {error && <div className="mt-4 bg-red-900/50 border border-red-700 text-red-200 rounded p-3 text-sm">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1">{label}</label>
      {children}
    </div>
  );
}