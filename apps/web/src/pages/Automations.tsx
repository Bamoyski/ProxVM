import { useSearchParams } from "react-router-dom";
import { Empty } from "../components/ui.js";
import Schedules from "./Schedules.js";
import Backups from "./Backups.js";

/** Automations: power schedules and PBS backups are both per-VM timetables
 *  with the same fleet-plus-timetable shape, so they share one page.
 *  Old routes (/schedules, /backups) redirect here — see App.tsx. */
export default function Automations({ can }: { can: (perm: string) => boolean }) {
  const [params, setParams] = useSearchParams();
  const tabs = [
    { id: "schedules", label: "Power schedules", perm: "vm.manage", panel: <Schedules /> },
    { id: "backups", label: "Backups", perm: "vm.manage", panel: <Backups /> },
  ].filter((t) => can(t.perm));
  const active = tabs.some((t) => t.id === params.get("tab")) ? params.get("tab")! : (tabs[0]?.id ?? "");
  const current = tabs.find((t) => t.id === active);

  return (
    <div className="pv-page">
      {tabs.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }} role="tablist" aria-label="Automation views">
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
      {current ? current.panel : <Empty title="No access" body="You don't have permission to view automations." />}
    </div>
  );
}
