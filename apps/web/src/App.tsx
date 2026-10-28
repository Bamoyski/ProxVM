import { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { useMe } from "./hooks/me.js";
import AppShell from "./shell/AppShell.js";
import { Spinner, RouteErrorBoundary } from "./ui/index.js";

/* Eager: auth surfaces (first paint) and the dashboard. */
import Login from "./pages/Login.js";
import SetupWizard from "./pages/SetupWizard.js";
import Dashboard from "./pages/Dashboard.js";
import Welcome from "./pages/Welcome.js";
import { shouldShowWelcome, WELCOME_DURATION_MS } from "./lib/welcome.js";

/* Route-level code splitting: everything else loads on navigation. */
const Vms = lazy(() => import("./pages/Vms.js"));
const VmDetail = lazy(() => import("./pages/VmDetail.js"));
const Guacamole = lazy(() => import("./pages/Guacamole.js"));
const Automations = lazy(() => import("./pages/Automations.js"));
const Credentials = lazy(() => import("./pages/Credentials.js"));
const Users = lazy(() => import("./pages/Users.js"));
const UserPermissions = lazy(() => import("./pages/UserPermissions.js"));
const Access = lazy(() => import("./pages/Access.js"));
const System = lazy(() => import("./pages/System.js"));
const Configuration = lazy(() => import("./pages/Configuration.js"));
const About = lazy(() => import("./pages/About.js"));
const Usage = lazy(() => import("./pages/Usage.js"));
const Tickets = lazy(() => import("./pages/Tickets.js"));

function RouteFallback() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "80px 0", color: "var(--pv-text-3)" }}>
      <Spinner size={18} />
    </div>
  );
}

export default function App() {
  const { data: me, isLoading } = useMe();
  const [setupMode, setSetupMode] = useState<boolean | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);

  useEffect(() => {
    api<{ mode: string; restartRequired?: boolean }>("/setup/status")
      .then((r) => {
        setSetupMode(r.mode === "setup");
        setRestartRequired(!!r.restartRequired);
      })
      .catch(() => setSetupMode(null));
  }, []);

  // Brief educational intro, once per app start. Never over first-run
  // setup or the restart-required screen; hiding simply hands control back
  // to the normal flow below (login or the app shell) — no full-page
  // navigation, so the timer cannot loop.
  useEffect(() => {
    if (!showWelcome && shouldShowWelcome({ isLoading, setupMode, restartRequired })) {
      setShowWelcome(true);
    }
  }, [isLoading, setupMode, restartRequired, showWelcome]);

  useEffect(() => {
    if (!showWelcome) return;
    const timer = setTimeout(() => setShowWelcome(false), WELCOME_DURATION_MS);
    return () => clearTimeout(timer);
  }, [showWelcome]);

  // Effective permissions (custom roles, group roles, direct grants) drive
  // nav visibility; the legacy role map is the fallback while this loads.
  // The backend remains authoritative for every real operation.
  const { data: effectiveData } = useQuery({
    queryKey: ["iam-effective"],
    queryFn: () => api<{ permissions: Array<{ permission: string }> }>("/iam/effective"),
    staleTime: 30000,
    retry: false,
    enabled: setupMode === false && !isLoading && me !== undefined && me !== null,
  });

  if (restartRequired) {
    return (
      <div className="pv-shell-center" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div className="pv-panel pv-page-narrow" style={{ textAlign: "center" }}>
          <h1 className="pv-page-title" style={{ justifyContent: "center", marginBottom: 8 }}>Setup complete</h1>
          <p className="pv-muted" style={{ margin: 0 }}>
            ProxVM was configured successfully. Restart the API process to finish first-run initialization
            (<code className="pv-mono">docker compose restart api worker</code> or restart your dev process),
            then reload this page.
          </p>
        </div>
      </div>
    );
  }

  if (setupMode === null || isLoading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pv-text-3)", gap: 10 }}>
        <Spinner size={18} /> Loading ProxVM…
      </div>
    );
  }

  if (showWelcome && !setupMode && !restartRequired) {
    return <Welcome onDone={() => setShowWelcome(false)} />;
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

  const effective = effectiveData ? new Set(effectiveData.permissions.map((p) => p.permission)) : null;
  /** Effective-first permission check for nav/link visibility. */
  const can = (perm: string, legacy: boolean): boolean =>
    effective ? effective.has(perm) : legacy;
  const isAdmin = me.roles.includes("ADMIN");
  const isOperator = me.roles.includes("OPERATOR");
  const privileged = isAdmin || isOperator;
  // Legacy fallback per permission while IAM loads (mirrors lib/permissions).
  const legacy = (perm: string): boolean => {
    if (perm === "vm.manage") return privileged;
    if (perm === "templates.manage") return privileged;
    if (perm === "jobs.read") return privileged;
    if (perm === "audit.read") return privileged || me.roles.includes("USER");
    if (perm === "drift.manage") return isAdmin;
    if (perm === "guac.launch") return true;
    return isAdmin;
  };

  return (
    <AppShell me={me} can={(perm) => can(perm, legacy(perm))}>
      <RouteErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<Dashboard me={me} can={(perm) => can(perm, true)} />} />
            <Route path="/vms" element={<Vms me={me} />} />
            <Route path="/vms/:id" element={<VmDetail me={me} />} />
            <Route path="/automations" element={<Automations can={(perm) => can(perm, legacy(perm))} />} />
            <Route path="/guacamole" element={<Guacamole />} />
            <Route path="/credentials" element={<Credentials />} />
            <Route path="/users" element={<Users />} />
            <Route path="/users/:id/permissions" element={<UserPermissions />} />
            <Route path="/access" element={<Access can={(perm) => can(perm, legacy(perm))} />} />
            <Route path="/system" element={<System can={(perm) => can(perm, legacy(perm))} />} />
            <Route path="/configuration" element={<Configuration can={(perm) => can(perm, legacy(perm))} />} />
            <Route path="/about" element={<About can={(perm) => can(perm, legacy(perm))} />} />
            <Route path="/usage" element={<Usage />} />
            <Route path="/tickets" element={<Tickets isAdmin={can("users.manage", isAdmin)} />} />
            {/* Legacy paths redirect so bookmarks and notification links keep
                working. Backend routes are unchanged. */}
            <Route path="/templates" element={<Navigate to="/vms?tab=templates" replace />} />
            <Route path="/roles" element={<Navigate to="/access?tab=roles" replace />} />
            <Route path="/groups" element={<Navigate to="/access?tab=groups" replace />} />
            <Route path="/matrix" element={<Navigate to="/access?tab=matrix" replace />} />
            <Route path="/health" element={<Navigate to="/system?tab=health" replace />} />
            <Route path="/threats" element={<Navigate to="/system?tab=threats" replace />} />
            <Route path="/drift" element={<Navigate to="/system?tab=drift" replace />} />
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
        </Suspense>
      </RouteErrorBoundary>
    </AppShell>
  );
}
