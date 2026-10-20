import { useState } from "react";
import { PageHeader, Section, Alert } from "../ui/index.js";

const TABS = ["Privacy Policy", "Terms of Use"] as const;

const doc: React.CSSProperties = { fontSize: "0.86rem", color: "var(--pv-text-2)", maxWidth: "46rem" };
const h3: React.CSSProperties = { fontSize: "0.9rem", fontWeight: 650, color: "var(--pv-text)", margin: "18px 0 6px" };

export default function Legal() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Privacy Policy");
  return (
    <div className="pv-page pv-page-narrow">
      <PageHeader title="Legal notices" />
      <Alert kind="warn" title="No expectation of privacy for users">
        Administrators of this instance can see your username, assigned VMs, jobs, and login history,
        and every credential reveal or copy is recorded in the audit log with their name on it. Assume
        anything you do here is visible to administrators.
      </Alert>
      <div className="pv-seg" role="group" aria-label="Legal document" style={{ marginBottom: 4 }}>
        {TABS.map((t) => (
          <button
            key={t}
            className={`pv-seg-btn${tab === t ? " pv-seg-btn-active" : ""}`}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Privacy Policy" && (
        <Section title="Privacy Policy">
          <div style={doc}>
            <p>
              ProxVM is self-hosted software: all data stays on infrastructure operated by whoever deployed
              this instance. There is no telemetry, no analytics, no advertising, and no data sent to the
              ProxVM authors or any third party by the application itself. (Your deployment may sit behind
              third-party infrastructure such as a reverse proxy or CDN — that is the operator's choice,
              not the application's.)
            </p>
            <h3 style={h3}>What is stored</h3>
            <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
              <li>Account data you provide: usernames, optional email addresses, and Argon2id password hashes (never plaintext passwords).</li>
              <li>VM guest credentials, encrypted with AES-256-GCM under a per-install master key.</li>
              <li>Infrastructure configuration you enter (Proxmox tokens, Guacamole database credentials), encrypted at rest.</li>
              <li>An audit log of security-relevant actions (logins, permission changes, credential reveals, VM lifecycle) with secret values redacted.</li>
              <li>Server-side sessions (login time, last activity, IP address, user agent) used for authentication, idle timeout, and lockout.</li>
            </ul>
            <h3 style={h3}>Cookies</h3>
            <p>
              One strictly-necessary session cookie (<span className="pv-mono">proxvm_session</span>, httpOnly,
              SameSite=strict) keeps you logged in. No tracking cookies exist. A per-session CSRF token is
              exchanged with the API on state-changing requests.
            </p>
            <h3 style={h3}>Your rights</h3>
            <p>
              Because data never leaves the operator's systems, privacy requests (access, correction, deletion)
              go to the operator of this instance, not to the software authors. Administrators can disable or
              delete accounts from the Users page; deleting a user also removes their Guacamole account.
            </p>
            <h3 style={h3}>Data retention</h3>
            <p>
              Sessions expire (absolute + idle timeouts) and are pruned automatically. Audit entries are kept
              until an administrator configures retention pruning in Settings, if that control is enabled on
              this instance.
            </p>
          </div>
        </Section>
      )}
      {tab === "Terms of Use" && (
        <Section title="Terms of Use">
          <div style={doc}>
            <p>
              ProxVM is experimental software provided under the MIT License without warranty
              of any kind. By using this instance you accept the following terms set by its operator:
            </p>
            <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
              <li>Use the platform only for lawful purposes and only against infrastructure you own or are authorized to manage.</li>
              <li>Keep your credentials secret. You are responsible for actions taken with your account, including audited credential reveals.</li>
              <li>Do not attempt to bypass access controls, escalate privileges, or disrupt the service or underlying Proxmox/Guacamole systems.</li>
              <li>Destructive actions (VM deletion, credential rotation, rollbacks) are intentional operations — confirmations cannot undo work already executed on real infrastructure.</li>
              <li>The operator may suspend or remove accounts that violate these terms or threaten the stability of shared systems.</li>
            </ul>
            <p>
              These terms supplement, and do not replace, the MIT License under which the software is
              distributed. Questions about the rules of a specific deployment go to its operator.
            </p>
          </div>
        </Section>
      )}
    </div>
  );
}
