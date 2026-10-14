import { useSearchParams } from "react-router-dom";
import { Empty } from "../components/ui.js";
import Settings from "./Settings.js";
import Domains from "./Domains.js";
import Content from "./Content.js";

/** Configuration: infrastructure settings, domains, and site content are
 *  all admin-only config screens, so they share one page with tabs.
 *  Old routes (/settings, /domains, /content) redirect here — see App.tsx. */
export default function Configuration({ can }: { can: (perm: string) => boolean }) {
  const [params, setParams] = useSearchParams();
  const tabs = [
    { id: "settings", label: "Settings", perm: "settings.manage", panel: <Settings /> },
    { id: "domains", label: "Domains", perm: "settings.manage", panel: <Domains /> },
    { id: "content", label: "Site content", perm: "settings.manage", panel: <Content /> },
  ].filter((t) => can(t.perm));
  const active = tabs.some((t) => t.id === params.get("tab")) ? params.get("tab")! : (tabs[0]?.id ?? "");
  const current = tabs.find((t) => t.id === active);

  return (
    <div className="pv-page">
      {tabs.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }} role="tablist" aria-label="Configuration views">
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
      {current ? current.panel : <Empty title="No access" body="Configuration requires administrator permissions." />}
    </div>
  );
}
