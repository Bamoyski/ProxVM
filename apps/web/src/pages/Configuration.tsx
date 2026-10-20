import { useSearchParams } from "react-router-dom";
import { EmptyState, Tabs } from "../ui/index.js";
import Settings from "./Settings.js";
import Domains from "./Domains.js";
import Content from "./Content.js";

/** Configuration: infrastructure settings, domains, and site content are
 *  all admin-only config screens, so they share one page with tabs.
 *  Old routes (/settings, /domains, /content) redirect here — see App.tsx. */
export default function Configuration({ can }: { can: (perm: string) => boolean }) {
  const [params, setParams] = useSearchParams();
  const all = [
    { id: "settings", label: "Settings", perm: "settings.manage", panel: <Settings /> },
    { id: "domains", label: "Domains", perm: "settings.manage", panel: <Domains /> },
    { id: "content", label: "Site content", perm: "settings.manage", panel: <Content /> },
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
          label="Configuration views"
        />
      ) : (
        tabs[0]?.panel
      )}
      {tabs.length === 0 && (
        <EmptyState title="No access" body="Configuration requires administrator permissions." />
      )}
    </div>
  );
}
