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
  legacy: (roles: string[]) => boolean;
  end?: boolean;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

const all = (): boolean => true;
const isAdmin = (roles: string[]): boolean => roles.includes("ADMIN");

export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ to: "/", label: "Overview", icon: Gauge, perm: null, legacy: all, end: true }],
  },
  {
    label: "Virtualization",
    items: [
      { to: "/vms", label: "Virtual machines", icon: Server, perm: null, legacy: all },
      { to: "/guacamole", label: "Consoles", icon: Monitor, perm: null, legacy: all },
      { to: "/automations", label: "Automations", icon: CalendarClock, perm: "vm.manage", legacy: (r) => r.includes("ADMIN") || r.includes("OPERATOR") },
    ],
  },
  {
    label: "Access & security",
    items: [
      { to: "/users", label: "Users", icon: UsersIcon, perm: "users.manage", legacy: isAdmin },
      { to: "/access", label: "Access control", icon: ShieldCheck, perm: null, legacy: (r) => r.includes("ADMIN") },
      { to: "/credentials", label: "Credentials", icon: KeyRound, perm: "cred.reveal", legacy: isAdmin },
      { to: "/tickets", label: "Support", icon: LifeBuoy, perm: null, legacy: all },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/system", label: "System & security", icon: Activity, perm: null, legacy: all },
      { to: "/configuration", label: "Configuration", icon: Settings, perm: "settings.manage", legacy: isAdmin },
      { to: "/usage", label: "Usage", icon: BarChart3, perm: "users.manage", legacy: isAdmin },
    ],
  },
  {
    label: null,
    items: [{ to: "/about", label: "About & help", icon: Info, perm: null, legacy: all }],
  },
];

/** Access control shows only when at least one of its parts is permitted. */
export function accessControlVisible(perm: (p: string) => boolean): boolean {
  return perm("roles.manage") || perm("groups.manage") || perm("users.manage");
}
