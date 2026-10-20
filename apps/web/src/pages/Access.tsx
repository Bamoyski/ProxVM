import { useSearchParams } from "react-router-dom";
import { EmptyState, Tabs } from "../ui/index.js";
import Roles from "./Roles.js";
import Groups from "./Groups.js";
import Matrix from "./Matrix.js";

/** Access control: roles, groups, and the read-only permission matrix are
 *  three views over the same IAM model, so they share one page with tabs.
 *  Each tab keeps its own permission gate; the backend stays authoritative.
 *  Old routes (/roles, /groups, /matrix) redirect here — see App.tsx. */
export default function Access({ can }: { can: (perm: string) => boolean }) {
  const [params, setParams] = useSearchParams();
  const all = [
    { id: "roles", label: "Roles", perm: "roles.manage", panel: <Roles /> },
    { id: "groups", label: "Groups", perm: "groups.manage", panel: <Groups /> },
    { id: "matrix", label: "Permission Matrix", perm: "users.manage", panel: <Matrix /> },
  ];
  const tabs = all.filter((t) => can(t.perm));
  const active = tabs.some((t) => t.id === params.get("tab")) ? params.get("tab")! : (tabs[0]?.id ?? "");
  const current = tabs.find((t) => t.id === active);

  return (
    <div className="pv-page">
      {tabs.length > 1 && (
        <Tabs
          tabs={tabs}
          active={active}
          onChange={(t) => setParams({ tab: t }, { replace: true })}
          label="Access control views"
        />
      )}
      {current ? current.panel : (
        <EmptyState
          title="No access"
          body="You don't have permission to view any access control section."
        />
      )}
    </div>
  );
}
