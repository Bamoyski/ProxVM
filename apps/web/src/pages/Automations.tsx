import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { EmptyState, Tabs } from "../ui/index.js";
import Schedules from "./Schedules.js";
import Backups from "./Backups.js";

/** Automations: power schedules and PBS backups are both per-VM timetables
 *  with the same fleet-plus-timetable shape, so they share one page.
 *  Old routes (/schedules, /backups) redirect here — see App.tsx. */
export default function Automations({ can }: { can: (perm: string) => boolean }) {
  const [params, setParams] = useSearchParams();
  const all = [
    { id: "schedules", label: "Power schedules", perm: "vm.manage", panel: <Schedules /> },
    { id: "backups", label: "Backups", perm: "vm.manage", panel: <Backups /> },
  ];
  const tabs = all.filter((t) => can(t.perm));
  const active = tabs.some((t) => t.id === params.get("tab")) ? params.get("tab")! : (tabs[0]?.id ?? "");

  return (
    <div className="pv-page">
      {tabs.length > 1 ? (
        <Tabs
          tabs={tabs}
          active={active}
          onChange={(t) => setParams({ tab: t }, { replace: true })}
          label="Automation views"
        />
      ) : (
        tabs[0]?.panel
      )}
      {tabs.length === 0 && (
        <EmptyState title="No access" body="You don't have permission to view automations." />
      )}
    </div>
  );
}
