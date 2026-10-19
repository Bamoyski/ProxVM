import { useEffect, useState } from "react";
import { Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, setCsrfToken, logout } from "./api.js";
import SetupWizard from "./pages/SetupWizard.js";
import Login from "./pages/Login.js";
import Dashboard from "./pages/Dashboard.js";
import Vms from "./pages/Vms.js";
import VmDetail from "./pages/VmDetail.js";
import Guacamole from "./pages/Guacamole.js";
import Credentials from "./pages/Credentials.js";
import Users from "./pages/Users.js";
import Access from "./pages/Access.js";
import UserPermissions from "./pages/UserPermissions.js";
import System from "./pages/System.js";
import ThreatBell from "./components/ThreatBell.js";
import NotificationBell from "./components/NotificationBell.js";
import Automations from "./pages/Automations.js";
import Configuration from "./pages/Configuration.js";
import About from "./pages/About.js";
import Usage from "./pages/Usage.js";
import Tickets from "./pages/Tickets.js";
import CommandPalette from "./components/CommandPalette.js";

export interface Me {
  user: { id: string; username: string; roles: string[] } | null;
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const res = await api<{ user: { id: string; username: string; roles: string[] } | null; csrfToken: string | null }>("/me");
        setCsrfToken(res.csrfToken);
        return res.user;
      } catch (err) {
        if (err instanceof Error && "statusCode" in err && (err as { statusCode: number }).statusCode === 401) {
          return null;
        }
        throw err;
      }
    },
  });
}

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/vms", label: "Virtual Machines" },
  { to: "/automations", label: "Automations" },
  { to: "/guacamole", label: "Guacamole" },
  { to: "/credentials", label: "Credentials" },
  { to: "/users", label: "Users" },
  { to: "/access", label: "Access control" },
  { to: "/system", label: "System & security" },
  { to: "/configuration", label: "Configuration" },
  { to: "/usage", label: "Usage" },
  { to: "/tickets", label: "Support" },
  { to: "/about", label: "About & help" },
];

function initialTheme(): "dark" | "light" {
  try {
    return window.localStorage.getItem("proxvm-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export default function App() {
  const { data: me, isLoading } = useMe();
  const [setupMode, setSetupMode] = useState<boolean | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api<{ mode: string; restartRequired?: boolean }>("/setup/status")
      .then((r) => {
        setSetupMode(r.mode === "setup");
        setRestartRequired(!!r.restartRequired);
      })
      .catch(() => setSetupMode(null));
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    try {
      window.localStorage.setItem("proxvm-theme", theme);
    } catch {
      // private mode: theme just won't persist
    }
  }, [theme]);

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

  // Hooks must run unconditionally on every render (Rules of Hooks): this
  // query sits above all early returns and stays disabled until a user is
  // authenticated outside of setup mode.
  const { data: effectiveData } = useQuery({
    queryKey: ["iam-effective"],
    queryFn: () => api<{ permissions: Array<{ permission: string }> }>("/iam/effective"),
    staleTime: 30000,
    retry: false,
    enabled: setupMode === false && !isLoading && me !== undefined && me !== null,
  });

  // Instance announcement (admin-set, settings-backed). Dismissal is keyed by
  // content hash so reposting the same text stays dismissed, but any edit
  // reappears for everyone.
  const { data: announcement } = useQuery({
    queryKey: ["announcement"],
    queryFn: () => api<{ text: string | null; level: "info" | "warn" }>("/announcement"),
    staleTime: 60000,
    retry: false,
    enabled: setupMode === false && !isLoading && me !== undefined && me !== null,
  });
  const announcementKey = announcement?.text
    ? `proxvm-announcement-${announcement.text.length}-${announcement.text.slice(0, 32)}`
    : null;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const showAnnouncement =
    !!announcement?.text &&
    announcementKey !== null &&
    dismissedKey !== announcementKey &&
    (() => {
      try {
        return window.localStorage.getItem(announcementKey) !== "1";
      } catch {
        return true;
      }
    })();
  const dismissAnnouncement = () => {
    if (announcementKey) {
      try {
        window.localStorage.setItem(announcementKey, "1");
      } catch {
        // private mode: dismissal just won't persist
      }
      setDismissedKey(announcementKey);
    }
  };

  if (restartRequired) {
    return (
      <div className="pv-shell" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="pv-panel pv-page-narrow" style={{ textAlign: "center" }}>
          <h1 className="pv-title" style={{ marginBottom: 8 }}>Setup complete</h1>
          <p className="pv-sub" style={{ margin: 0 }}>
            ProxVM was configured successfully. Restart the API process to finish first-run initialization
            (<span className="pv-mono">docker compose restart api worker</span> or restart your dev process), then reload this page.
          </p>
        </div>
      </div>
    );
  }

  if (setupMode === null || isLoading) {
    return <div className="pv-shell" style={{ alignItems: "center", justifyContent: "center", color: "var(--pv-text-3)" }}>Loading…</div>;
  }

  if (setupMode) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupWizard onDone={() => setSetupMode(false)} />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const isAdmin = me.roles.includes("ADMIN");
  const isOperator = me.roles.includes("OPERATOR");
  const privileged = isAdmin || isOperator;
  const hasAuditRead = me.roles.some((r) => r === "ADMIN" || r === "OPERATOR");
  // Effective permissions (custom roles, group roles, direct grants) drive
  // nav visibility with the legacy role checks as fallback while loading.
  // Backend remains authoritative; this only decides which links render.
  const effective = effectiveData ? new Set(effectiveData.permissions.map((p) => p.permission)) : null;
  const canNav = (perm: string, legacy: boolean): boolean =>
    effective ? effective.has(perm) : legacy;
  // Legacy fallback per permission for the Help page, mirroring the sidebar
  // rules above: pages without a nav filter are visible to everyone.
  const helpLegacy = (perm: string): boolean => {
    if (perm === "templates.manage" || perm === "jobs.read") return privileged;
    if (perm === "audit.read") return hasAuditRead;
    if (["users.manage", "roles.manage", "groups.manage", "cred.reveal", "settings.manage"].includes(perm)) {
      return isAdmin;
    }
    return true;
  };

  const visibleNav = NAV.filter((n) => {
    if (n.to === "/users") return canNav("users.manage", isAdmin);
    if (n.to === "/usage") return canNav("users.manage", isAdmin);
    if (n.to === "/configuration") return canNav("settings.manage", isAdmin);
    if (n.to === "/access") {
      return (
        canNav("roles.manage", isAdmin) ||
        canNav("groups.manage", isAdmin) ||
        canNav("users.manage", isAdmin)
      );
    }
    if (n.to === "/credentials") return canNav("cred.reveal", isAdmin);
    if (n.to === "/automations") return canNav("vm.manage", privileged);
    if (n.to === "/system") return true;
    if (n.to === "/about") return true;
    return true;
  });

  // Grouped by operator intent, not alphabet: infrastructure first,
  // automation and identity next, system last. Help-adjacent pages live
  // under About & help.
  const NAV_GROUPS: Array<{ label: string | null; paths: string[] }> = [
    { label: "Infrastructure", paths: ["/", "/vms", "/guacamole", "/credentials"] },
    { label: "Automations", paths: ["/automations"] },
    { label: "Access", paths: ["/users", "/access"] },
    { label: "System", paths: ["/system", "/configuration", "/usage"] },
    { label: null, paths: ["/tickets", "/about"] },
  ];
  const navByPath = new Map(visibleNav.map((n) => [n.to, n]));

  return (
    <div className="pv-shell">
      <div className="pv-topbar">
        <span className="pv-brand" style={{ padding: 0 }}>Prox<b>VM</b></span>
        <button
          className="pv-btn pv-btn-sm"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Toggle navigation"
        >
          Menu
        </button>
        {canNav("audit.read", hasAuditRead) && <ThreatBell />}
        <NotificationBell />
      </div>
      {menuOpen && (
        <div className="pv-scrim" onClick={() => setMenuOpen(false)} />
      )}
      <aside className={`pv-sidebar ${menuOpen ? "pv-sidebar-open" : ""}`}>
        <div className="pv-brand">Prox<b>VM</b></div>
        <nav>
          {NAV_GROUPS.map((g) => {
            const items = g.paths
              .map((p) => navByPath.get(p))
              .filter((n): n is { to: string; label: string } => !!n);
            if (!items.length) return null;
            return (
              <div key={g.label ?? "other"}>
                {g.label ? <div className="pv-navgroup">{g.label}</div> : <div style={{ height: 14 }} />}
                {items.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.to === "/"}
                    onClick={() => setMenuOpen(false)}
                    className={({ isActive }) => `pv-navlink${isActive ? " pv-navlink-active" : ""}`}
                  >
                    {n.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="pv-sidefoot">
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="pv-btn pv-btn-sm"
              style={{ flex: 1 }}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title="Toggle dark / light theme"
            >
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            <button
              className="pv-btn pv-btn-sm"
              style={{ flex: 1 }}
              onClick={() => {
                setMenuOpen(false);
                setPaletteOpen(true);
              }}
              title="Command palette (Ctrl+K)"
            >
              ⌘K
            </button>
          </div>
          <div className="pv-userline">
            {me.username} <span>({me.roles.join(", ")})</span>
          </div>
          <button
            onClick={async () => {
              await logout();
              window.location.href = "/login";
            }}
            className="pv-btn pv-btn-sm"
          >
            Log out
          </button>
          <div style={{ fontSize: 11, color: "var(--pv-text-3)", textAlign: "center" }}>
            by{" "}
            <a
              style={{ color: "inherit" }}
              href="https://github.com/Bamoyski"
              target="_blank"
              rel="noreferrer"
            >
              bamoyskistudios
            </a>
          </div>
        </div>
      </aside>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        nav={visibleNav}
        canViewUsers={canNav("users.manage", isAdmin)}
        go={(to) => {
          setPaletteOpen(false);
          setMenuOpen(false);
          navigate(to);
        }}
      />
      <main className="pv-main">
        {showAnnouncement && announcement?.text && (
          <div className={`pv-notice ${announcement.level === "warn" ? "pv-notice-warn" : ""}`} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ flex: 1 }}>{announcement.text}</span>
            <button className="pv-btn pv-btn-link" style={{ fontSize: "0.78rem", flex: "none" }} onClick={dismissAnnouncement}>
              Dismiss
            </button>
          </div>
        )}
        <Routes>
          <Route path="/" element={<Dashboard me={me} can={(perm) => canNav(perm, true)} />} />
          <Route path="/vms" element={<Vms me={me} />} />
          <Route path="/vms/:id" element={<VmDetail me={me} />} />
          <Route path="/automations" element={<Automations can={(perm) => canNav(perm, helpLegacy(perm))} />} />
          <Route path="/guacamole" element={<Guacamole />} />
          <Route path="/credentials" element={<Credentials />} />
          <Route path="/users" element={<Users />} />
          <Route path="/users/:id/permissions" element={<UserPermissions />} />
          <Route path="/access" element={<Access can={(perm) => canNav(perm, helpLegacy(perm))} />} />
          <Route path="/system" element={<System can={(perm) => canNav(perm, helpLegacy(perm))} />} />
          <Route path="/configuration" element={<Configuration can={(perm) => canNav(perm, helpLegacy(perm))} />} />
          <Route path="/about" element={<About can={(perm) => canNav(perm, helpLegacy(perm))} />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/tickets" element={<Tickets isAdmin={canNav("users.manage", isAdmin)} />} />
          {/* Consolidated pages: old per-section paths redirect to the
            matching tab so bookmarks, notification links, and in-app links
            keep working. Backend routes are unchanged. */}
          <Route path="/templates" element={<Navigate to="/vms?tab=templates" replace />} />
          <Route path="/roles" element={<Navigate to="/access?tab=roles" replace />} />
          <Route path="/groups" element={<Navigate to="/access?tab=groups" replace />} />
          <Route path="/matrix" element={<Navigate to="/access?tab=matrix" replace />} />
          <Route path="/health" element={<Navigate to="/system?tab=health" replace />} />
          <Route path="/threats" element={<Navigate to="/system?tab=threats" replace />} />
          <Route path="/audit" element={<Navigate to="/system?tab=audit" replace />} />
          <Route path="/jobs" element={<Navigate to="/" replace />} />
          <Route path="/jobs/:jobId" element={<Navigate to="/" replace />} />
          <Route path="/schedules" element={<Navigate to="/automations?tab=schedules" replace />} />
          <Route path="/backups" element={<Navigate to="/automations?tab=backups" replace />} />
          <Route path="/settings" element={<Navigate to="/configuration?tab=settings" replace />} />
          <Route path="/domains" element={<Navigate to="/configuration?tab=domains" replace />} />
          <Route path="/content" element={<Navigate to="/configuration?tab=content" replace />} />
          <Route path="/help" element={<Navigate to="/about?tab=help" replace />} />
          <Route path="/contact" element={<Navigate to="/about?tab=contact" replace />} />
          <Route path="/donate" element={<Navigate to="/about?tab=donate" replace />} />
          <Route path="/legal" element={<Navigate to="/about?tab=legal" replace />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function useInvalidate() {
  const qc = useQueryClient();
  return (key: string) => {
    void qc.invalidateQueries({ queryKey: [key] });
  };
}