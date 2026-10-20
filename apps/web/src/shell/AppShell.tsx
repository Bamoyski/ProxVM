import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sun,
  Moon,
  LogOut,
  Info,
  AlertTriangle,
  X,
  Terminal,
  Zap,
} from "lucide-react";
import { api, logout } from "../api.js";
import type { MeUser } from "../hooks/me.js";
import { NAV_GROUPS, accessControlVisible, type NavItem } from "./nav.js";
import { Popover, useConfirm } from "../ui/index.js";
import CommandPalette from "../components/CommandPalette.js";
import NotificationBell from "../components/NotificationBell.js";
import ThreatBell from "../components/ThreatBell.js";
import { usePref } from "../prefs.js";

/** Icon rail/collapsed mode is desktop-only and browser-local. */
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem("proxvm-pref:sidebar-collapsed") === "true";
  } catch {
    return false;
  }
}

/* One-time migration: the pre-redesign app stored the theme under a raw
 * `proxvm-theme` key (plain string, no namespace). Carry it over so an
 * existing light-theme user doesn't get flipped back to dark. Runs once at
 * module load; a stale legacy key after that is ignored. */
try {
  if (window.localStorage.getItem("proxvm-pref:theme") === null) {
    const legacyTheme = window.localStorage.getItem("proxvm-theme");
    if (legacyTheme === "light" || legacyTheme === "dark") {
      window.localStorage.setItem("proxvm-pref:theme", JSON.stringify(legacyTheme));
    }
  }
} catch {
  // private mode: nothing to migrate
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/* ============================ announcement ========================== */

function AnnouncementBar() {
  const { data } = useQuery({
    queryKey: ["announcement"],
    queryFn: () => api<{ text: string | null; level: "info" | "warn" }>("/announcement"),
    staleTime: 60000,
    retry: false,
  });
  const key = data?.text
    ? `proxvm-announcement-${data.text.length}-${data.text.slice(0, 32)}`
    : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const visible =
    !!data?.text && key !== null && dismissed !== key &&
    (() => {
      try {
        return window.localStorage.getItem(key) !== "1";
      } catch {
        return true;
      }
    })();
  if (!visible || !data?.text || !key) return null;
  return (
    <div className={`pv-alert pv-alert-${data.level === "warn" ? "warn" : "info"}`} style={{ margin: "12px 0 0" }} role="status">
      <AlertTriangle size={15} className="pv-alert-ico" aria-hidden="true" style={data.level === "warn" ? undefined : { display: "none" }} />
      <div className="pv-alert-body">{data.text}</div>
      <button
        className="pv-btn pv-btn-ghost pv-btn-sm"
        onClick={() => {
          try {
            window.localStorage.setItem(key, "1");
          } catch {
            // private mode: dismissal just won't persist
          }
          setDismissed(key);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

/* ============================= breadcrumbs ========================== */

const CRUMB_LABELS: Record<string, string> = {
  vms: "Virtual machines",
  guacamole: "Consoles",
  automations: "Automations",
  users: "Users",
  access: "Access control",
  credentials: "Credentials",
  tickets: "Support",
  system: "System & security",
  configuration: "Configuration",
  usage: "Usage",
  about: "About & help",
};

function useCrumbs(): Array<{ label: string; to?: string }> {
  const loc = useLocation();
  const segs = loc.pathname.split("/").filter(Boolean);
  const isVmDetail = segs[0] === "vms" && segs.length === 2;
  // Share the VM-detail cache with the page itself (same query key).
  const { data } = useQuery({
    queryKey: ["vm", segs[1] ?? ""],
    queryFn: () => api<{ vm: { name: string } }>(`/vms/${segs[1]}`),
    enabled: isVmDetail,
    staleTime: 5000,
  });
  return useMemo(() => {
    if (!segs.length) return [{ label: "Overview" }];
    const head = CRUMB_LABELS[segs[0]!] ?? segs[0]!;
    const crumbs: Array<{ label: string; to?: string }> = [{ label: head, to: segs.length > 1 ? `/${segs[0]}` : undefined }];
    if (segs[0] === "vms" && segs[1]) {
      crumbs.push({ label: data?.vm?.name ?? `VM ${segs[1].slice(0, 8)}` });
    } else if (segs.length > 1) {
      crumbs.push({ label: segs.slice(1).join(" / ") });
    }
    return crumbs;
  }, [loc.pathname, data]); // eslint-disable-line react-hooks/exhaustive-deps
}

/* ============================== sidebar ============================= */

function NavItemLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon;
  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => `pv-nav-link${isActive ? " pv-nav-link-active" : ""}`}
      title={collapsed ? item.label : undefined}
    >
      <Icon size={16} className="pv-nav-ico" aria-hidden="true" />
      {!collapsed && <span className="pv-truncate">{item.label}</span>}
    </NavLink>
  );
  if (!collapsed) return link;
  return <span style={{ display: "block" }}>{link}</span>;
}

/* =============================== shell ============================== */

export default function AppShell({
  me,
  can,
  children,
}: {
  me: MeUser;
  can: (perm: string) => boolean;
  children: ReactNode;
}) {
  const loc = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = usePref<"dark" | "light">("theme", "dark");
  const confirm = useConfirm();
  const crumbs = useCrumbs();

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
  }, [theme]);

  useEffect(() => {
    setMobileOpen(false);
  }, [loc.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem("proxvm-pref:sidebar-collapsed", JSON.stringify(next));
      } catch {
        // private mode: preference just won't persist
      }
      return next;
    });
  };

  const groups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((item) => {
      if (item.to === "/access") return accessControlVisible(can);
      return item.perm === null || can(item.perm);
    }),
  })).filter((g) => g.items.length > 0);

  const visibleNav: Array<{ to: string; label: string }> = groups.flatMap((g) =>
    g.items.map((i) => ({ to: i.to, label: i.label })),
  );

  const doLogout = async () => {
    const ok = await confirm({
      title: "Log out?",
      body: "Your session ends and Guacamole sessions minted by it are revoked.",
      confirmLabel: "Log out",
    });
    if (!ok) return;
    await logout();
    window.location.href = "/login";
  };

  return (
    <div className={`pv-app${collapsed ? " pv-collapsed" : ""}`}>
      {mobileOpen && <div className="pv-scrim" onClick={() => setMobileOpen(false)} aria-hidden="true" />}

      <aside
        className={`pv-sidebar${collapsed ? " pv-sidebar-collapsed" : ""}${mobileOpen ? " pv-sidebar-open" : ""}`}
        aria-label="Primary navigation"
      >
        <div className="pv-side-head">
          <Link to="/" className="pv-brand" aria-label="ProxVM home">
            <span className="pv-brand-mark" aria-hidden="true">
              <Terminal size={15} strokeWidth={2.2} />
            </span>
            {!collapsed && <span className="pv-brand-name">Prox<b>VM</b></span>}
          </Link>
        </div>
        <nav className="pv-side-nav">
          {groups.map((g, gi) => (
            <div key={g.label ?? `g${gi}`}>
              {g.label && !collapsed && <div className="pv-nav-group">{g.label}</div>}
              {g.label && collapsed && <div className="pv-nav-group" style={{ padding: 0, textAlign: "center", letterSpacing: 0 }}>·</div>}
              {g.items.map((item) => (
                <NavItemLink key={item.to} item={item} collapsed={collapsed} />
              ))}
            </div>
          ))}
        </nav>
        <div className="pv-side-foot">
          {!collapsed && (
            <button className="pv-cmd-btn" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
              <Search size={13} aria-hidden="true" />
              <span className="pv-cmd-btn-label">Search…</span>
              <span className="pv-kbd">Ctrl K</span>
            </button>
          )}
          <Popover
            label="Account menu"
            width={230}
            trigger={({ open, toggle, ref }) => (
              <button ref={ref} className="pv-user-btn" aria-expanded={open} onClick={toggle}>
                <span className="pv-avatar" aria-hidden="true">{initials(me.username)}</span>
                {!collapsed && (
                  <span className="pv-user-meta">
                    <div className="pv-user-name">{me.username}</div>
                    <div className="pv-user-roles">{me.roles.join(", ") || "no roles"}</div>
                  </span>
                )}
              </button>
            )}
          >
            {(close) => (
              <>
                <button
                  className="pv-menu-item"
                  onClick={() => {
                    setTheme(theme === "dark" ? "light" : "dark");
                    close();
                  }}
                >
                  {theme === "dark" ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
                  {theme === "dark" ? "Light theme" : "Dark theme"}
                </button>
                <button
                  className="pv-menu-item"
                  onClick={() => {
                    close();
                    setPaletteOpen(true);
                  }}
                >
                  <Search size={14} aria-hidden="true" />
                  Command palette
                  <span className="pv-menu-item-hint">Ctrl K</span>
                </button>
                <div className="pv-menu-sep" role="separator" />
                <button className="pv-menu-item pv-menu-item-danger" onClick={() => { close(); void doLogout(); }}>
                  <LogOut size={14} aria-hidden="true" />
                  Log out
                </button>
              </>
            )}
          </Popover>
        </div>
      </aside>

      <div className="pv-body">
        <header className="pv-header">
          <button
            className="pv-btn pv-btn-ghost pv-btn-icon pv-nav-toggle"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation menu"
          >
            <MenuIcon size={16} aria-hidden="true" />
          </button>
          <button
            className="pv-btn pv-btn-ghost pv-btn-icon pv-sidebar-toggle"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen size={15} aria-hidden="true" /> : <PanelLeftClose size={15} aria-hidden="true" />}
          </button>
          <nav className="pv-crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} style={{ display: "inline-flex", gap: 6, minWidth: 0 }}>
                {i > 0 && (
                  <span className="pv-crumbs-sep" aria-hidden="true">/</span>
                )}
                {c.to ? (
                  <Link to={c.to}>{c.label}</Link>
                ) : (
                  <span className="pv-crumbs-cur" aria-current="page">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
          <div className="pv-header-actions">
            {can("audit.read") && <ThreatBell />}
            <NotificationBell />
          </div>
        </header>

        <main className="pv-main">
          <AnnouncementBar />
          {children}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        nav={visibleNav}
        canViewUsers={can("users.manage")}
        go={(to) => {
          setPaletteOpen(false);
          navigate(to);
        }}
      />
    </div>
  );
}
