import {
  Gauge,
  Server,
  Monitor,
  CalendarClock,
  Users as UsersIcon,
  ShieldCheck,
  KeyRound,
  LifeBuoy,
  Activity,
  Settings,
  BarChart3,
  Info,
  type LucideIcon,
} from "lucide-react";

/**
 * Sidebar navigation. Visibility: `perm` is checked against the effective
 * permission set with a legacy role fallback (see App). The backend stays
 * authoritative for every actual operation — this only decides what links
 * render.
 */
export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Permission required to see the link (null = always visible). */
  perm: string | null;
  end?: boolean;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ to: "/", label: "Overview", icon: Gauge, perm: null, end: true }],
  },
  {
    label: "Virtualization",
    items: [
      { to: "/vms", label: "Virtual machines", icon: Server, perm: null },
      { to: "/guacamole", label: "Consoles", icon: Monitor, perm: null },
      { to: "/automations", label: "Automations", icon: CalendarClock, perm: "vm.manage" },
    ],
  },
  {
    label: "Access & security",
    items: [
      { to: "/users", label: "Users", icon: UsersIcon, perm: "users.manage" },
      { to: "/access", label: "Access control", icon: ShieldCheck, perm: null },
      { to: "/credentials", label: "Credentials", icon: KeyRound, perm: "cred.reveal" },
      { to: "/tickets", label: "Support", icon: LifeBuoy, perm: null },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/system", label: "System & security", icon: Activity, perm: null },
      { to: "/configuration", label: "Configuration", icon: Settings, perm: "settings.manage" },
      { to: "/usage", label: "Usage", icon: BarChart3, perm: "users.manage" },
    ],
  },
  {
    label: null,
    items: [{ to: "/about", label: "About & help", icon: Info, perm: null }],
  },
];

/** Access control shows only when at least one of its parts is permitted. */
export function accessControlVisible(perm: (p: string) => boolean): boolean {
  return perm("roles.manage") || perm("groups.manage") || perm("users.manage");
}
