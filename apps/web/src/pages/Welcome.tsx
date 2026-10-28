import { useEffect, useState } from "react";

/**
 * Brief educational intro shown once at app start (see App.tsx + lib/welcome).
 * Content is deliberately generic and scholarly — product-neutral.
 * App controls the duration and transition; a manual "Continue" lets the
 * impatient skip it.
 */
export default function Welcome({ onDone }: { onDone: () => void }) {
  const [ready, setReady] = useState(false);

  // One frame of plain mount lets the panel paint without a flash of stale
  // loading UI; keep it imperceptible (a single animation frame).
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="pv-shell-center" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div className="pv-panel pv-page-narrow" style={{ textAlign: "center" }}>
        <h1 className="pv-page-title" style={{ justifyContent: "center", marginBottom: 8 }}>Introduction</h1>
        <p className="pv-muted" style={{ margin: "0 0 16px" }}>
          This platform provides a unified interface for managing virtual
          infrastructure and remote desktop access, integrating
          virtualization capabilities with console connectivity in a
          centralized control point for distributed environments.
        </p>
        <div style={{ textAlign: "left", margin: "0 auto", maxWidth: 420 }}>
          <div style={{ marginBottom: 10 }}>
            <span className="pv-mono" style={{ marginRight: 6 }}>▸</span>
            <span>Virtual machine lifecycle management</span>
          </div>
          <div style={{ marginBottom: 10 }}>
            <span className="pv-mono" style={{ marginRight: 6 }}>▸</span>
            <span>Remote console access and session management</span>
          </div>
          <div style={{ marginBottom: 10 }}>
            <span className="pv-mono" style={{ marginRight: 6 }}>▸</span>
            <span>Role-based access control and permissions</span>
          </div>
          <div style={{ marginBottom: 10 }}>
            <span className="pv-mono" style={{ marginRight: 6 }}>▸</span>
            <span>Automated task scheduling and orchestration</span>
          </div>
        </div>
        <button
          className="pv-btn pv-btn-primary"
          style={{ marginTop: 20, opacity: ready ? 1 : 0 }}
          onClick={onDone}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
