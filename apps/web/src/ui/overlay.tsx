import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X, AlertTriangle } from "lucide-react";
import { Btn, IconButton } from "./Button.js";

/* ============================== dialog ============================== */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog with focus trap: focus moves in on open, Escape and scrim
 * close it, focus returns to the opener. Content is children — the caller
 * owns form state.
 */
export function Dialog({
  title,
  children,
  footer,
  onClose,
  wide,
  closeLabel = "Close",
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  closeLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    return () => prevFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Trap Tab within the dialog.
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (n) => n.offsetParent !== null,
      );
      if (!nodes.length) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="pv-dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`pv-dialog${wide ? " pv-dialog-wide" : ""}`}
        tabIndex={-1}
      >
        <div className="pv-dialog-head">
          <h2 className="pv-dialog-title" id={titleId}>
            {title}
          </h2>
          <IconButton label={closeLabel} className="pv-dialog-close" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
        <div className="pv-dialog-body">{children}</div>
        {footer && <div className="pv-dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* =========================== confirmation =========================== */

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** When set, the user must type this exact text to enable confirmation. */
  requireText?: string;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmCtx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const [typed, setTyped] = useState("");

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      setTyped("");
      setPending({ opts, resolve });
    });
  }, []);

  const settle = (v: boolean) => {
    pending?.resolve(v);
    setPending(null);
    setTyped("");
  };

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {pending && (
        <Dialog
          title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {pending.opts.danger && (
                <AlertTriangle size={15} style={{ color: "var(--pv-err)" }} aria-hidden="true" />
              )}
              {pending.opts.title}
            </span>
          }
          onClose={() => settle(false)}
          footer={
            <>
              <Btn onClick={() => settle(false)}>{pending.opts.cancelLabel ?? "Cancel"}</Btn>
              <Btn
                kind={pending.opts.danger ? "danger" : "primary"}
                disabled={!!pending.opts.requireText && typed !== pending.opts.requireText}
                onClick={() => settle(true)}
              >
                {pending.opts.confirmLabel ?? "Confirm"}
              </Btn>
            </>
          }
        >
          {pending.opts.body && <div style={{ marginBottom: 14 }}>{pending.opts.body}</div>}
          {pending.opts.requireText && (
            <div className="pv-field" style={{ marginBottom: 0 }}>
              <label className="pv-label" htmlFor="pv-confirm-text">
                Type <code className="pv-mono">{pending.opts.requireText}</code> to confirm
              </label>
              <input
                id="pv-confirm-text"
                className="pv-input pv-mono"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}
        </Dialog>
      )}
    </ConfirmCtx.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}

/* ============================== popover ============================= */

/**
 * Anchor + rich panel (notifications, user menu). Closes on outside click
 * and Escape; panel receives dialog semantics. Trigger is a render prop.
 */
export function Popover({
  trigger,
  children,
  label,
  align = "right",
  width = 300,
}: {
  trigger: (props: { open: boolean; toggle: () => void; ref: React.Ref<HTMLButtonElement> }) => ReactNode;
  children: (close: () => void) => ReactNode;
  label: string;
  align?: "left" | "right";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      {trigger({ open, toggle: () => setOpen((v) => !v), ref: triggerRef })}
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className="pv-menu"
          style={{
            width,
            maxWidth: "calc(100vw - 24px)",
            top: "calc(100% + 8px)",
            ...(align === "right" ? { right: 0 } : { left: 0 }),
          }}
        >
          {children(() => {
            setOpen(false);
            triggerRef.current?.focus();
          })}
        </div>
      )}
    </span>
  );
}

/* =============================== menu =============================== */

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * Dropdown menu anchored to its trigger: outside-click and Escape close it,
 * items are focusable buttons.
 */
export function Menu({
  trigger,
  items,
  align = "right",
  label,
}: {
  trigger: (props: { open: boolean; toggle: () => void; ref: React.Ref<HTMLButtonElement> }) => ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      {trigger({ open, toggle: () => setOpen((v) => !v), ref: triggerRef })}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="pv-menu"
          style={{
            top: "calc(100% + 6px)",
            ...(align === "right" ? { right: 0 } : { left: 0 }),
          }}
        >
          {items.map((item, i) => (
            <div key={i}>
              {i > 0 && item.danger && <div className="pv-menu-sep" role="separator" />}
              <button
                type="button"
                role="menuitem"
                className={`pv-menu-item${item.danger ? " pv-menu-item-danger" : ""}`}
                aria-disabled={item.disabled || undefined}
                onClick={() => {
                  if (item.disabled) return;
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon}
                {item.label}
                {item.hint && <span className="pv-menu-item-hint">{item.hint}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
