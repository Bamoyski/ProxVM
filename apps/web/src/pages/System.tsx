import { useSearchParams } from "react-router-dom";
import { Empty } from "../components/ui.js";
import Health from "./Health.js";
import Threats from "./Threats.js";
import Audit from "./Audit.js";

/** System & security: health, threat findings (computed from audit events),
 *  and the audit log itself — one observability surface. Health is visible
 *  to everyone; threats and audit need audit.read. Old routes (/health,
 *  /threats, /audit) redirect here — see App.tsx. */
export default function System({ can }: { can: (perm: string) => boolean }) {
  const [params, setParams] = useSearchParams();
  const tabs = [
    { id: "health", label: "Health", perm: "", panel: <Health /> },
    { id: "threats", label: "Threats", perm: "audit.read", panel: <Threats /> },
    { id: "audit", label: "Audit log", perm: "audit.read", panel: <Audit /> },
  ].filter((t) => !t.perm || can(t.perm));
  const active = tabs.some((t) => t.id === params.get("tab")) ? params.get("tab")! : (tabs[0]?.id ?? "");
  const current = tabs.find((t) => t.id === active);

  return (
    <div className="pv-page">
      {tabs.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }} role="tablist" aria-label="System views">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === active}
              onClick={() => setParams({ tab: t.id })}
              className={t.id === active ? "pv-btn pv-btn-primary pv-btn-sm" : "pv-btn pv-btn-sm"}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {current ? current.panel : <Empty title="No access" body="You don't have permission to view this section." />}
    </div>
  );
}
