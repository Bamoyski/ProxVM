import { Component, useEffect, useState, type ReactNode } from "react";
import { useDocTitle } from "./feedback.js";

/* ============================ page header =========================== */

export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small inline badges/status shown next to the title. */
  meta?: ReactNode;
}) {
  useDocTitle(typeof title === "string" ? title : "ProxVM");
  return (
    <div className="pv-page-head">
      <div className="pv-page-head-main">
        <h1 className="pv-page-title">
          {title}
          {meta}
        </h1>
        {description && <p className="pv-page-desc">{description}</p>}
      </div>
      {actions && <div className="pv-page-actions">{actions}</div>}
    </div>
  );
}

/* ============================== section ============================= */

export function Section({
  title,
  hint,
  actions,
  children,
  id,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="pv-section" id={id} style={id ? { scrollMarginTop: 70 } : undefined}>
      <div className="pv-section-head">
        <h2 className="pv-section-title">{title}</h2>
        {hint && <span className="pv-section-hint">{hint}</span>}
        {actions && <div className="pv-section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/* =========================== key/value ============================== */

export function KeyValue({
  items,
  columns = 1,
}: {
  items: Array<{ key: string; label: ReactNode; value: ReactNode }>;
  columns?: 1 | 3;
}) {
  return (
    <dl className={`pv-kv${columns === 3 ? " pv-kv-3" : ""}`}>
      {items.map((it) => (
        <div key={it.key} style={{ display: "contents" }}>
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ================================ stat ============================== */

export function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="pv-stat" title={hint}>
      <div className="pv-stat-label">{label}</div>
      <div className="pv-stat-value" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
    </div>
  );
}

/* ============================== tabs ================================ */

export interface TabDef {
  id: string;
  label: ReactNode;
  panel: ReactNode;
}

/**
 * Underline tabs. Selection is controlled — container pages back it with
 * URL search params so links, refresh, and history keep the active tab.
 */
export function Tabs({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <>
      <div className="pv-tabs" role="tablist" aria-label={label}>
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={t.id === active}
            aria-controls={`tabpanel-${t.id}`}
            className={`pv-tab${t.id === active ? " pv-tab-active" : ""}`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`tabpanel-${t.id}`}
          aria-labelledby={`tab-${t.id}`}
          hidden={t.id !== active}
        >
          {t.id === active ? t.panel : null}
        </div>
      ))}
    </>
  );
}

/* ============================ error boundary ======================== */

interface BoundaryProps {
  children: ReactNode;
  onReset?: () => void;
}

interface BoundaryState {
  error: Error | null;
}

/** Per-route error boundary: one broken section never blanks the app. */
export class RouteErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidUpdate(prev: BoundaryProps): void {
    // Reset when navigating to a different route (children identity change).
    if (prev.children !== this.props.children && this.state.error) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="pv-page-narrow" style={{ paddingTop: 40 }}>
          <div className="pv-alert pv-alert-err">
            <div className="pv-alert-body">
              <div className="pv-alert-title">This section failed to render</div>
              <div>The rest of ProxVM is unaffected — your data is safe. Reload the page, or navigate back.</div>
              <code className="pv-mono" style={{ display: "block", marginTop: 8, wordBreak: "break-all" }}>
                {this.state.error.message}
              </code>
            </div>
          </div>
          <button className="pv-btn pv-btn-primary" onClick={() => window.location.reload()}>
            Reload the page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Document title effect for pages that don't render PageHeader. */
export { useDocTitle };

/** Debounce a changing value (search boxes, filter inputs). */
export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
