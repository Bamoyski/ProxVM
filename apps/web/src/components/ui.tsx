import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api.js";

/** Status as dot + text with fixed meaning: ok (running/ready), warn
 * (attention-worthy), err (broken), info, muted (neutral/off). Never pills. */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = status ?? "unknown";
  const tone =
    s === "running" || s === "READY" || s === "ACTIVE" || s === "VERIFIED" || s === "ONLINE" || s === "connected"
      ? "pv-status-ok"
      : s === "FAILED" || s === "OFFLINE" || s === "ERROR" || s === "ROTATING" || s === "failed" || s === "disconnected"
        ? "pv-status-err"
        : s === "unknown" || s === "stopped" || s === "PENDING" || s === "PROVISIONED" || s === "ENCRYPTED" || s === "CANCELLED" || s === "UNCONFIGURED"
          ? ""
          : "pv-status-warn";
  return <span className={`pv-status ${tone}`}>{s}</span>;
}

export function PageTitle({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — ProxVM`;
    return () => {
      document.title = "ProxVM";
    };
  }, [title]);
  return (
    <div className="pv-title-row">
      <h1 className="pv-title">{title}</h1>
      {children ? <div className="pv-title-actions">{children}</div> : null}
      {description ? <p className="pv-sub" style={{ flexBasis: "100%", marginBottom: 18 }}>{description}</p> : null}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return <div className="pv-error">{message}</div>;
}

/** One primary action per group; everything else secondary, ghost, or danger. */
export function Btn({ kind, size, ...rest }: {
  kind?: "primary" | "secondary" | "danger" | "link";
  size?: "sm";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls =
    kind === "primary" ? "pv-btn pv-btn-primary" :
    kind === "danger" ? "pv-btn pv-btn-danger" :
    kind === "link" ? "pv-btn pv-btn-link" :
    "pv-btn";
  return <button className={size === "sm" ? `${cls} pv-btn-sm` : cls} {...rest} />;
}

export function Section({ title, hint, actions, children, id }: {
  title: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="pv-section" id={id} style={id ? { scrollMarginTop: 16 } : undefined}>
      <div className="pv-section-head">
        <h2 className="pv-section-title">{title}</h2>
        {hint ? <p className="pv-section-hint">{hint}</p> : null}
        {actions ? <div className="pv-section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="pv-empty">
      <b>{title}</b>
      {body ? <span>{body}</span> : null}
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

export function ConfirmDialog({
  title,
  requiredText,
  onConfirm,
  onCancel,
  busy,
}: {
  title: string;
  requiredText: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [text, setText] = useState("");
  const valid = text === requiredText;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="pv-panel" style={{ width: "28rem", maxWidth: "calc(100vw - 32px)", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
        <h2 className="pv-title" style={{ fontSize: "1.05rem", marginBottom: 6 }}>{title}</h2>
        <p className="pv-sub" style={{ marginBottom: 14 }}>
          Type <span className="pv-mono">{requiredText}</span> to confirm. This action cannot be undone.
        </p>
        <input
          className="pv-input pv-mono"
          style={{ marginBottom: 16 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={requiredText}
          autoFocus
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} className="pv-btn">
            Cancel
          </button>
          <button disabled={!valid || busy} onClick={onConfirm} className="pv-btn pv-btn-danger">
            {busy ? "Working…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useApiAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (err) {
      setBusy(false);
      throw err;
    }
  };
  return { busy, setBusy, run };
}

export async function confirmAndRun(
  action: () => Promise<unknown>,
  setBusy: (b: boolean) => void,
): Promise<void> {
  try {
    await action();
  } finally {
    setBusy(false);
  }
}

export function useConfirm() {
  const [confirm, setConfirm] = useState<{ title: string; requiredText: string; action: () => Promise<void> } | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = confirm ? (
    <ConfirmDialog
      title={confirm.title}
      requiredText={confirm.requiredText}
      busy={busy}
      onConfirm={async () => {
        setBusy(true);
        try {
          await confirm.action();
          setConfirm(null);
        } catch (err) {
          alert(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
      onCancel={() => setConfirm(null)}
    />
  ) : null;
  return { confirm: (title: string, requiredText: string, action: () => Promise<void>) => setConfirm({ title, requiredText, action }), dialog };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function masked(): string {
  return "••••••••••••••••••";
}

export { api };