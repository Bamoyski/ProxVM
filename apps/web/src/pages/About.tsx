import { useSearchParams } from "react-router-dom";
import { Tabs } from "../ui/index.js";
import Help from "./Help.js";
import Contact from "./Contact.js";
import Donate from "./Donate.js";
import Legal from "./Legal.js";

/** About: help guides plus the small static pages (contact, donate, legal)
 *  in one place. All public; Help filters its own sections by permission.
 *  Old routes (/help, /contact, /donate, /legal) redirect here — see App.tsx. */
export default function About({ can }: { can: (perm: string) => boolean }) {
  const [params, setParams] = useSearchParams();
  const tabs = [
    { id: "help", label: "Help", panel: <Help can={can} /> },
    { id: "contact", label: "Contact", panel: <Contact /> },
    { id: "donate", label: "Donate", panel: <Donate /> },
    { id: "legal", label: "Legal", panel: <Legal /> },
  ];
  const active = tabs.some((t) => t.id === params.get("tab")) ? params.get("tab")! : "help";
  const current = tabs.find((t) => t.id === active) ?? tabs[0]!;

  return (
    <div className="pv-page">
      <Tabs
        tabs={tabs}
        active={active}
        onChange={(t) => setParams({ tab: t }, { replace: true })}
        label="About views"
      />
      {current.panel}
    </div>
  );
}
