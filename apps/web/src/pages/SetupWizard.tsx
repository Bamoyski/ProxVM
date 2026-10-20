import { useState } from "react";
import { api } from "../api.js";
import { Field } from "../ui/index.js";

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

  const input = "pv-input";
  const label = "pv-label";

  // One-time setup token from the server log. Stored in sessionStorage so a
  // reload doesn't lose it; never in localStorage (it dies with completion).
  const [setupToken, setSetupToken] = useState(() => sessionStorage.getItem("proxvm-setup-token") ?? "");
  const saveSetupToken = (v: string) => {
    setSetupToken(v);
    if (v) sessionStorage.setItem("proxvm-setup-token", v);
    else sessionStorage.removeItem("proxvm-setup-token");
  };
  const tokenOpt = setupToken ? { setupToken } : {};

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
        { method: "POST", body: proxmox, ...tokenOpt },
      );
      if (!res.ok) throw new Error(res.error ?? "Proxmox test failed");
      setTestResult(`Connected to Proxmox ${res.version} — nodes: ${res.nodes?.map((n) => n.node).join(", ")}`);
    });

  const testGuacamole = () =>
    run(async () => {
      const res = await api<{ ok: boolean; error?: string; schemaVersion?: string | null; webReachable?: boolean | null; webDetail?: string | null }>(
        "/setup/test-guacamole",
        { method: "POST", body: guacamole, ...tokenOpt },
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
        ...tokenOpt,
      });
      if (!res.ok) throw new Error(res.error ?? "Database test failed");
      setTestResult(`Connected to PostgreSQL ${res.serverVersion ?? ""}`);
    });

  const testRedis = () =>
    run(async () => {
      const res = await api<{ ok: boolean; host?: string; port?: number; error?: string }>("/setup/test-redis", {
        method: "POST",
        body: { host: redis.host, port: redis.port, password: redis.password || undefined, db: redis.db },
        ...tokenOpt,
      });
      if (!res.ok) throw new Error(res.error ?? "Redis test failed");
      setTestResult(`Connected to Redis at ${res.host}:${res.port}`);
    });

  const finalize = () =>
    run(async () => {
      const res = await api<{ ok: boolean; checks: Record<string, unknown> }>("/setup/complete", {
        method: "POST",
        ...tokenOpt,
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
      sessionStorage.removeItem("proxvm-setup-token");
      setSetupToken("");
    });

  function Nav({ onNext, nextLabel, back = true }: { onNext: () => void; nextLabel: string; back?: boolean }) {
    return (
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
        <button
          onClick={() => setStep((s) => Math.max(1, s - 1))}
          className="pv-btn"
          style={back ? undefined : { visibility: "hidden" }}
        >
          Back
        </button>
        <button onClick={onNext} className="pv-btn pv-btn-primary">
          {nextLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="pv-shell" style={{ alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 640 }}>
        <div className="pv-brand" style={{ padding: "0 0 2px", fontSize: "1.2rem" }}>Prox<b>VM</b> setup</div>
        <p className="pv-sub" style={{ marginBottom: 20 }}>Configure your Proxmox and Guacamole infrastructure. Each test step runs a real connection check.</p>
        <div className="pv-panel" style={{ marginBottom: 16 }}>
          <label className={label} htmlFor="setup-token">Setup token (from the API server log)</label>
          <input
            id="setup-token"
            type="password"
            className={input}
            autoComplete="off"
            placeholder="64-hex token from the server console"
            value={setupToken}
            onChange={(e) => saveSetupToken(e.target.value.trim())}
          />
        </div>
        <ol style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "0 0 20px", padding: 0, listStyle: "none" }}>
          {STEPS.map((s, i) => (
            <li
              key={s}
              className="pv-mono"
              style={{
                fontSize: "0.72rem", padding: "4px 8px", borderRadius: 6,
                border: "1px solid var(--pv-border)",
                background: i + 1 === step ? "var(--pv-accent)" : "transparent",
                borderColor: i + 1 === step ? "var(--pv-accent)" : "var(--pv-border)",
                color: i + 1 === step ? "var(--pv-accent-ink)" : i + 1 < step ? "var(--pv-ok)" : "var(--pv-text-3)",
              }}
            >
              {i + 1}. {s}
            </li>
          ))}
        </ol>

        <div className="pv-panel">
          {step === 1 && (
            <>
              <h2 className="pv-title" style={{ fontSize: "1.05rem", marginBottom: 16 }}>Step 1 — Create administrator</h2>
              <Field label="Username">
                <input className={input} value={admin.username} onChange={(e) => setAdmin({ ...admin, username: e.target.value })} />
              </Field>
              <Field label="Email (optional)">
                <input className={input} value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} />
              </Field>
              <Field label="Password (min 12 chars, upper/lower/number/symbol)">
                <input type="password" className={input} value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} />
              </Field>
              <Nav onNext={() => setStep(2)} nextLabel="Next: Proxmox" />
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="pv-title" style={{ fontSize: "1.05rem", marginBottom: 16 }}>Step 2 — Configure Proxmox</h2>
              <Field label="Proxmox URL">
                <input className={input} value={proxmox.url} onChange={(e) => setProxmox({ ...proxmox, url: e.target.value })} />
              </Field>
              <Field label="API Token ID (e.g. root@pam!proxvm)">
                <input className={input} value={proxmox.tokenId} onChange={(e) => setProxmox({ ...proxmox, tokenId: e.target.value })} />
              </Field>
              <Field label="API Token secret">
                <input type="password" className={input} value={proxmox.tokenSecret} onChange={(e) => setProxmox({ ...proxmox, tokenSecret: e.target.value })} />
              </Field>
              <label className="pv-checkrow" style={{ marginBottom: 12 }}>
                <input type="checkbox" checked={proxmox.verifySsl} onChange={(e) => setProxmox({ ...proxmox, verifySsl: e.target.checked })} />
                Verify SSL certificate (disable for self-signed certificates)
              </label>
              <div className="pv-grid-3">
                <Field label="Default node"><input className={input} value={proxmox.defaultNode} onChange={(e) => setProxmox({ ...proxmox, defaultNode: e.target.value })} /></Field>
                <Field label="Default storage"><input className={input} value={proxmox.defaultStorage} onChange={(e) => setProxmox({ ...proxmox, defaultStorage: e.target.value })} /></Field>
                <Field label="Default bridge"><input className={input} value={proxmox.defaultNetwork} onChange={(e) => setProxmox({ ...proxmox, defaultNetwork: e.target.value })} /></Field>
              </div>
              <Nav onNext={() => setStep(3)} nextLabel="Next: Test connection" />
            </>
          )}

          {step === 3 && (
            <>
              <h2 className="pv-title" style={{ fontSize: "1.05rem", marginBottom: 8 }}>Step 3 — Test Proxmox connection</h2>
              <p className="pv-sub">Performs a real API call to your Proxmox server.</p>
              <button onClick={testProxmox} disabled={busy} className="pv-btn pv-btn-primary">
                {busy ? "Testing…" : "Test connection"}
              </button>
              {testResult && <div className="pv-alert pv-alert-ok" style={{ marginTop: 12 }}>{testResult}</div>}
              <Nav onNext={() => setStep(4)} nextLabel="Next: Guacamole" />
            </>
          )}

          {step === 4 && (
            <>
              <h2 className="pv-title" style={{ fontSize: "1.05rem", marginBottom: 16 }}>Step 4 — Configure Guacamole</h2>
              <Field label="Database engine">
                <select
                  className="pv-select"
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
              <Field label="Public URL (for browser access, e.g. https://guacamole.example.com/)">
                <input className={input} value={guacamole.publicUrl} onChange={(e) => setGuacamole({ ...guacamole, publicUrl: e.target.value })} placeholder="Leave empty to use the URL above" />
              </Field>
              <div className="pv-grid-2">
                <Field label="Database host"><input className={input} value={guacamole.dbHost} onChange={(e) => setGuacamole({ ...guacamole, dbHost: e.target.value })} /></Field>
                <Field label="Database port"><input type="number" className={input} value={guacamole.dbPort} onChange={(e) => setGuacamole({ ...guacamole, dbPort: Number(e.target.value) })} /></Field>
              </div>
              <Field label="Database name"><input className={input} value={guacamole.dbName} onChange={(e) => setGuacamole({ ...guacamole, dbName: e.target.value })} /></Field>
              <Field label="Database user"><input className={input} value={guacamole.dbUser} onChange={(e) => setGuacamole({ ...guacamole, dbUser: e.target.value })} /></Field>
              <Field label="Database password"><input type="password" className={input} value={guacamole.dbPassword} onChange={(e) => setGuacamole({ ...guacamole, dbPassword: e.target.value })} /></Field>
              <Nav onNext={() => setStep(5)} nextLabel="Next: Test connection" />
            </>
          )}

          {step === 5 && (
            <>
              <h2 className="pv-title" style={{ fontSize: "1.05rem", marginBottom: 8 }}>Step 5 — Test Guacamole connection</h2>
              <p className="pv-sub">Real database connection + schema check, plus Guacamole web app reachability.</p>
              <button onClick={testGuacamole} disabled={busy} className="pv-btn pv-btn-primary">
                {busy ? "Testing…" : "Test connection"}
              </button>
              {testResult && <div className="pv-alert" style={{ marginTop: 12 }}>{testResult}</div>}
              <Nav onNext={() => setStep(6)} nextLabel="Next: Database" />
            </>
          )}

          {step === 6 && (
            <>
              <h2 className="pv-title" style={{ fontSize: "1.05rem", marginBottom: 16 }}>Step 6 — Application database & Redis</h2>
              <div className="pv-grid-2">
                <Field label="PostgreSQL host"><input className={input} value={database.host} onChange={(e) => setDatabase({ ...database, host: e.target.value })} /></Field>
                <Field label="Port"><input type="number" className={input} value={database.port} onChange={(e) => setDatabase({ ...database, port: Number(e.target.value) })} /></Field>
              </div>
              <Field label="Database name"><input className={input} value={database.name} onChange={(e) => setDatabase({ ...database, name: e.target.value })} /></Field>
              <Field label="Database user"><input className={input} value={database.user} onChange={(e) => setDatabase({ ...database, user: e.target.value })} /></Field>
              <Field label="Database password"><input type="password" className={input} value={database.password} onChange={(e) => setDatabase({ ...database, password: e.target.value })} /></Field>
              <hr style={{ border: "none", borderTop: "1px solid var(--pv-border-soft)", margin: "16px 0" }} />
              <div className="pv-grid-2">
                <Field label="Redis host"><input className={input} value={redis.host} onChange={(e) => setRedis({ ...redis, host: e.target.value })} /></Field>
                <Field label="Redis port"><input type="number" className={input} value={redis.port} onChange={(e) => setRedis({ ...redis, port: Number(e.target.value) })} /></Field>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
                <button onClick={() => setStep(5)} className="pv-btn">Back</button>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={testDatabase} disabled={busy} className="pv-btn pv-btn-primary">
                    {busy ? "Testing…" : "Test database"}
                  </button>
                  <button onClick={testRedis} disabled={busy} className="pv-btn pv-btn-primary">
                    {busy ? "Testing…" : "Test Redis"}
                  </button>
                  <button onClick={() => setStep(7)} className="pv-btn">Next: Encryption</button>
                </div>
              </div>
              {testResult && <div className="pv-alert" style={{ marginTop: 12 }}>{testResult}</div>}
            </>
          )}

          {step === 7 && (
            <>
              <h2 className="pv-title" style={{ fontSize: "1.05rem", marginBottom: 8 }}>Step 7 — Initialize encryption & finalize</h2>
              <p className="pv-sub">
                A master encryption key (AES-256-GCM) and session signing key are generated securely and stored server-side in{" "}
                <span className="pv-mono">.proxvm/config.json</span>. VM passwords and infrastructure secrets are encrypted with the master key.
              </p>
              <p className="pv-sub">
                Finalizing connects to PostgreSQL and Redis for real, runs migrations, creates the administrator, stores your
                Proxmox/Guacamole configuration (encrypted), and runs real integration checks.
              </p>
              <button onClick={finalize} disabled={busy} className="pv-btn pv-btn-primary">
                {busy ? "Initializing…" : "Initialize and run integration checks"}
              </button>
              <div style={{ display: "flex", justifyContent: "flex-start", marginTop: 24 }}>
                <button onClick={() => setStep(6)} className="pv-btn">Back</button>
              </div>
            </>
          )}

          {step === 8 && (
            <>
              <h2 className="pv-title" style={{ fontSize: "1.05rem", marginBottom: 16 }}>Step 8 — Integration checks</h2>
              <pre className="pv-mono" style={{ background: "var(--pv-inset)", border: "1px solid var(--pv-border-soft)", borderRadius: 6, padding: 12, fontSize: "0.76rem", overflow: "auto", marginBottom: 16 }}>{JSON.stringify(checks, null, 2)}</pre>
              <button
                onClick={() => {
                  onDone();
                  window.location.href = "/login";
                }}
                className="pv-btn pv-btn-primary"
              >
                Enter dashboard
              </button>
            </>
          )}

          {error && <div className="pv-error" style={{ marginTop: 16 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}

/* Field is the shared primitive (ui/index.js) — it wires the label to the
   control, so every setup input is announced correctly. */
