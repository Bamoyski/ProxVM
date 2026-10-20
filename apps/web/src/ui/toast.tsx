import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from "lucide-react";

/**
 * Toast feedback system (replaces every legacy alert()). Kinds carry fixed
 * meaning across the app: ok = completed, err = failed, warn = partial or
 * needs attention, info = acknowledged/running. Errors persist longer.
 */

export type ToastKind = "ok" | "err" | "warn" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

interface ToastApi {
  toast: (t: { kind?: ToastKind; title: string; description?: string }) => number;
  ok: (title: string, description?: string) => number;
  err: (title: string, description?: string) => number;
  warn: (title: string, description?: string) => number;
  info: (title: string, description?: string) => number;
  dismiss: (id: number) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

const ICONS: Record<ToastKind, typeof Info> = {
  ok: CheckCircle2,
  err: XCircle,
  warn: AlertTriangle,
  info: Info,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastApi["toast"]>(({ kind = "info", title, description }) => {
    const id = nextId.current++;
    setItems((list) => [...list.slice(-4), { id, kind, title, description }]);
    const ttl = kind === "err" ? 10000 : 6000;
    timers.current.set(
      id,
      setTimeout(() => dismiss(id), ttl),
    );
    return id;
  }, [dismiss]);

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      ok: (title, description) => toast({ kind: "ok", title, description }),
      err: (title, description) => toast({ kind: "err", title, description }),
      warn: (title, description) => toast({ kind: "warn", title, description }),
      info: (title, description) => toast({ kind: "info", title, description }),
      dismiss,
    }),
    [toast, dismiss],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      {/* Polite live region: screen readers hear new feedback without focus theft. */}
      <div className="pv-toasts" role="status" aria-live="polite" aria-atomic="false">
        {items.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <div key={t.id} className={`pv-toast pv-toast-${t.kind}`}>
              <Icon size={15} className="pv-toast-ico" aria-hidden="true" />
              <div className="pv-toast-body">
                <div className="pv-toast-title">{t.title}</div>
                {t.description && <div className="pv-toast-desc">{t.description}</div>}
              </div>
              <button
                className="pv-btn pv-btn-ghost pv-btn-icon pv-btn-sm"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

/** Human-readable rendering of an unknown thrown value. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
