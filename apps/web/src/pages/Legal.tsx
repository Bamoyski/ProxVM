import { useState } from "react";
import { PageTitle } from "../components/ui.js";

const TABS = ["Privacy Policy", "Terms of Use"] as const;

export default function Legal() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Privacy Policy");
  return (
    <div className="max-w-4xl">
      <PageTitle title="Legal Notices" />
      <div className="flex gap-2 mb-6">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm rounded ${tab === t ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Privacy Policy" && (
        <div className="bg-slate-900 border border-slate-800 rounded p-5 text-sm text-slate-300 space-y-3">
          <h2 className="text-base font-medium text-slate-100">Privacy Policy</h2>
          <p>
            ProxVM is self-hosted software: all data stays on infrastructure operated by whoever deployed
            this instance. There is no telemetry, no analytics, no advertising, and no data sent to the
            ProxVM authors or any third party by the application itself. (Your deployment may sit behind
            third-party infrastructure such as a reverse proxy or CDN — that is the operator's choice,
            not the application's.)
          </p>
          <h3 className="font-medium text-slate-100">What is stored</h3>
          <ul className="list-disc list-inside space-y-1 text-slate-400">
            <li>Account data you provide: usernames, optional email addresses, and Argon2id password hashes (never plaintext passwords).</li>
            <li>VM guest credentials, encrypted with AES-256-GCM under a per-install master key.</li>
            <li>Infrastructure configuration you enter (Proxmox tokens, Guacamole database credentials), encrypted at rest.</li>
            <li>An audit log of security-relevant actions (logins, permission changes, credential reveals, VM lifecycle) with secret values redacted.</li>
            <li>Server-side sessions (login time, last activity, IP address, user agent) used for authentication, idle timeout, and lockout.</li>
          </ul>
          <h3 className="font-medium text-slate-100">Cookies</h3>
          <p className="text-slate-400">
            One strictly-necessary session cookie (<span className="font-mono">proxvm_session</span>, httpOnly,
            SameSite=strict) keeps you logged in. No tracking cookies exist. A per-session CSRF token is
            exchanged with the API on state-changing requests.
          </p>
          <h3 className="font-medium text-slate-100">Your rights</h3>
          <p className="text-slate-400">
            Because data never leaves the operator's systems, privacy requests (access, correction, deletion)
            go to the operator of this instance, not to the software authors. Administrators can disable or
            delete accounts from the Users page; deleting a user also removes their Guacamole account.
          </p>
          <h3 className="font-medium text-slate-100">Data retention</h3>
          <p className="text-slate-400">
            Sessions expire (absolute + idle timeouts) and are pruned automatically. Audit entries are kept
            until an administrator configures retention pruning in Settings, if that control is enabled on
            this instance.
          </p>
        </div>
      )}
      {tab === "Terms of Use" && (
        <div className="bg-slate-900 border border-slate-800 rounded p-5 text-sm text-slate-300 space-y-3">
          <h2 className="text-base font-medium text-slate-100">Terms of Use</h2>
          <p>
            ProxVM is experimental, AI-generated software provided under the MIT License without warranty
            of any kind. By using this instance you accept the following terms set by its operator:
          </p>
          <ul className="list-disc list-inside space-y-1 text-slate-400">
            <li>Use the platform only for lawful purposes and only against infrastructure you own or are authorized to manage.</li>
            <li>Keep your credentials secret. You are responsible for actions taken with your account, including audited credential reveals.</li>
            <li>Do not attempt to bypass access controls, escalate privileges, or disrupt the service or underlying Proxmox/Guacamole systems.</li>
            <li>Destructive actions (VM deletion, credential rotation, rollbacks) are intentional operations — confirmations cannot undo work already executed on real infrastructure.</li>
            <li>The operator may suspend or remove accounts that violate these terms or threaten the stability of shared systems.</li>
          </ul>
          <p className="text-slate-400">
            These terms supplement, and do not replace, the MIT License under which the software is
            distributed. Questions about the rules of a specific deployment go to its operator.
          </p>
        </div>
      )}
    </div>
  );
}
