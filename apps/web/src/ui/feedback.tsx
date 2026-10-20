import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
  Inbox,
  Copy,
  Check,
} from "lucide-react";

/* ============================== status ============================== */

/**
 * Status vocabulary with fixed meaning everywhere in the app:
 *   ok   — running / healthy / completed / verified
 *   warn — pending / degraded / starting / rotating
 *   err  — failed / offline / broken
 *   info — active / connected (interactive-but-neutral)
 *   none — stopped / cancelled / unknown (neutral, NOT an error)
 * Dot + text always; never color alone.
 */

const OK_SET = new Set([
  "running", "READY", "ACTIVE", "VERIFIED", "ONLINE", "connected", "ok", "OK", "online", "approved",
]);
const ERR_SET = new Set([
  "FAILED", "OFFLINE", "ERROR", "failed", "disconnected", "REJECTED", "rejected", "error",
]);
const NEUTRAL_SET = new Set([
  "unknown", "stopped", "PENDING", "PROVISIONED", "ENCRYPTED", "CANCELLED", "UNCONFIGURED",
  "stopped", "CLOSED", "closed",
]);
const INFO_SET = new Set(["RUNNING", "running-pending"]);

export type StatusTone = "ok" | "warn" | "err" | "info" | "none";

export function statusTone(status: string | null | undefined): StatusTone {
  const s = (status ?? "unknown").trim();
  if (OK_SET.has(s)) return "ok";
  if (ERR_SET.has(s)) return "err";
  if (NEUTRAL_SET.has(s)) return "none";
  if (INFO_SET.has(s)) return "info";
  // Starting/stopping/rotating/queued etc: transitional → warn
  return "warn";
}

const TONE_CLASS: Record<StatusTone, string> = {
  ok: "pv-status-ok",
  warn: "pv-status-warn",
  err: "pv-status-err",
  info: "pv-status-info",
  none: "",
};

export function StatusBadge({
  status,
  label,
  animate,
}: {
  status: string | null | undefined;
  label?: string;
  animate?: boolean;
}) {
  const s = status ?? "unknown";
  const tone = statusTone(s);
  return (
    <span className={`pv-status ${TONE_CLASS[tone]}${animate && tone === "warn" ? " pv-status-anim" : ""}`}>
      {label ?? s}
    </span>
  );
}

/* =============================== badges ============================= */

export type BadgeTone = "neutral" | "ok" | "warn" | "err" | "info" | "plain";

export function Badge({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const cls = tone === "neutral" ? "pv-badge" : tone === "plain" ? "pv-badge pv-badge-plain" : `pv-badge pv-badge-${tone}`;
  return (
    <span className={cls}>
      {icon}
      {children}
    </span>
  );
}

/* =============================== alerts ============================= */

const ALERT_ICON = {
  info: Info,
  warn: AlertTriangle,
  err: XCircle,
  ok: CheckCircle2,
} as const;

export function Alert({
  kind = "info",
  title,
  children,
  actions,
}: {
  kind?: keyof typeof ALERT_ICON;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const Icon = ALERT_ICON[kind];
  return (
    <div className={`pv-alert pv-alert-${kind}`} role={kind === "err" ? "alert" : undefined}>
      <Icon size={15} className="pv-alert-ico" aria-hidden="true" />
      <div className="pv-alert-body">
        {title && <div className="pv-alert-title">{title}</div>}
        {children}
      </div>
      {actions && <div style={{ flex: "none" }}>{actions}</div>}
    </div>
  );
}

/* ============================ empty states ========================== */

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="pv-empty">
      <div className="pv-empty-ico">{icon ?? <Inbox size={26} aria-hidden="true" />}</div>
      <div className="pv-empty-title">{title}</div>
      {body && <div className="pv-empty-body">{body}</div>}
      {action && <div className="pv-empty-action">{action}</div>}
    </div>
  );
}

/* ============================= skeletons ============================ */

export function Skeleton({ width, height = 14 }: { width?: number | string; height?: number }) {
  return <span className="pv-skeleton" style={{ display: "inline-block", width: width ?? "100%", height }} aria-hidden="true" />;
}

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ padding: 12 }} aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: "flex", gap: 16, padding: "8px 0", borderBottom: "1px solid var(--pv-border-soft)" }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} width={c === 0 ? 140 : `${Math.round(60 + ((r * 7 + c * 13) % 40))}%`} height={12} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ============================= meters =============================== */

export function Meter({
  value,
  max = 100,
  tone,
  title,
}: {
  value: number;
  max?: number;
  tone?: "ok" | "hot" | "crit";
  title?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const cls = tone ? `pv-meter pv-meter-${tone}` : "pv-meter";
  return (
    <div className={cls} title={title} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={title}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Threshold tone for utilization: ok < 70 ≤ hot < 90 ≤ crit. */
export function utilTone(pct: number): "ok" | "hot" | "crit" {
  return pct >= 90 ? "crit" : pct >= 70 ? "hot" : "ok";
}

export function Progress({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <div className="pv-progress pv-progress-indeterminate" aria-label="Working">
        <i />
      </div>
    );
  }
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="pv-progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ display: "block", height: "100%", borderRadius: 999, background: "var(--pv-accent)", width: `${pct}%` }} />
    </div>
  );
}

/* ============================= tooltip ============================== */

export function Tooltip({
  content,
  children,
  align = "center",
}: {
  content: ReactNode;
  children: ReactNode;
  align?: "center" | "left";
}) {
  const [open, setOpen] = useState(false);
  const id = useRef(`tip-${Math.random().toString(36).slice(2, 9)}`).current;
  return (
    <span
      className={`pv-tip${align === "left" ? " pv-tip-left" : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} style={{ display: "inline-flex" }}>
        {children}
      </span>
      {open && (
        <span className="pv-tip-bubble" role="tooltip" id={id}>
          {content}
        </span>
      )}
    </span>
  );
}

/* ============================ copyable ============================== */

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="pv-btn pv-btn-ghost pv-btn-icon pv-btn-sm pv-copy-btn"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // clipboard blocked: leave icon unchanged
        }
      }}
    >
      {done ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    </button>
  );
}

/** Monospace technical value with hover-reveal copy button. */
export function CopyableCode({ value }: { value: string }) {
  return (
    <span className="pv-copyable">
      <code className="pv-mono pv-truncate" style={{ userSelect: "all" }}>
        {value}
      </code>
      <CopyButton text={value} label={`Copy ${value}`} />
    </span>
  );
}

/** Count-up-free animated refresh hint: briefly flashes a subtle ring. */
export function useRefreshFlash(): { ref: React.RefObject<HTMLSpanElement>; flash: () => void } {
  const ref = useRef<HTMLSpanElement>(null);
  const flash = () => {
    const el = ref.current;
    if (!el) return;
    el.animate(
      [{ opacity: 0.4 }, { opacity: 1 }],
      { duration: 400, easing: "ease-out" },
    );
  };
  return { ref, flash };
}

/* ========================= page-load effect ========================= */

/** Sets document.title for the lifetime of the page. */
export function useDocTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} — ProxVM`;
    return () => {
      document.title = "ProxVM";
    };
  }, [title]);
}
