import { useSearchParams } from "react-router-dom";
import { EmptyState, Tabs } from "../ui/index.js";
import Health from "./Health.js";
import Threats from "./Threats.js";
import Audit from "./Audit.js";

/** System & security: health, threat findings (computed from audit events),
 *  and the audit log itself — one observability surface. Health is visible
 *  to everyone; threats and audit need audit.read. Old routes (/health,
 *  /threats, /audit) redirect here — see App.tsx. */
export default function System({ can }: { can: (perm: string) => boolean }) {
  const [params, setParams] = useSearchParams();
  const all = [
    { id: "health", label: "Health", perm: "", panel: <Health can={can} /> },
    { id: "threats", label: "Threats", perm: "audit.read", panel: <Threats /> },
    { id: "audit", label: "Audit log", perm: "audit.read", panel: <Audit /> },
  ];
  const tabs = all.filter((t) => !t.perm || can(t.perm));
  const active = tabs.some((t) => t.id === params.get("tab")) ? params.get("tab")! : (tabs[0]?.id ?? "");
  const current = tabs.find((t) => t.id === active);

  return (
    <div className="pv-page">
      {tabs.length > 1 && (
        <Tabs
          tabs={tabs}
          active={active}
          onChange={(t) => setParams({ tab: t }, { replace: true })}
          label="System views"
        />
      )}
      {current ? current.panel : (
        <EmptyState title="No access" body="You don't have permission to view this section." />
      )}
    </div>
  );
}
