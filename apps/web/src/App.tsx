import { useEffect, useState } from "react";
import { Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, setCsrfToken, logout } from "./api.js";
import SetupWizard from "./pages/SetupWizard.js";
import Login from "./pages/Login.js";
import Dashboard from "./pages/Dashboard.js";
import Vms from "./pages/Vms.js";
import VmDetail from "./pages/VmDetail.js";
import Templates from "./pages/Templates.js";
import Guacamole from "./pages/Guacamole.js";
import Credentials from "./pages/Credentials.js";
import Users from "./pages/Users.js";
import Roles from "./pages/Roles.js";
import Groups from "./pages/Groups.js";
import Matrix from "./pages/Matrix.js";
import UserPermissions from "./pages/UserPermissions.js";
import Audit from "./pages/Audit.js";
import Jobs from "./pages/Jobs.js";
import Settings from "./pages/Settings.js";
import Health from "./pages/Health.js";

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
  { to: "/templates", label: "Templates" },
  { to: "/guacamole", label: "Guacamole" },
  { to: "/credentials", label: "Credentials" },
  { to: "/users", label: "Users" },
  { to: "/roles", label: "Roles" },
  { to: "/groups", label: "Groups" },
  { to: "/matrix", label: "Permission Matrix" },
  { to: "/audit", label: "Audit Log" },
  { to: "/jobs", label: "Jobs" },
  { to: "/settings", label: "Settings" },
  { to: "/health", label: "Health" },
];

export default function App() {
  const { data: me, isLoading } = useMe();
  const [setupMode, setSetupMode] = useState<boolean | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    api<{ mode: string; restartRequired?: boolean }>("/setup/status")
      .then((r) => {
        setSetupMode(r.mode === "setup");
        setRestartRequired(!!r.restartRequired);
      })
      .catch(() => setSetupMode(null));
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

  if (restartRequired) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-8 max-w-md text-center">
          <h1 className="text-xl font-semibold text-blue-400 mb-2">Setup complete</h1>
          <p className="text-sm text-slate-400">
            ProxVM was configured successfully. Restart the API process to finish first-run initialization
            (<span className="font-mono">docker compose restart api worker</span> or restart your dev process), then reload this page.
          </p>
        </div>
      </div>
    );
  }

  if (setupMode === null || isLoading) {
    return <div className="min-h-screen flex items-center justify-center text-slate-400">Loading…</div>;
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

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 shrink-0 bg-slate-900 border-r border-slate-800 p-4 flex flex-col">
        <div className="text-xl font-bold text-blue-400 mb-6">ProxVM</div>
        <nav className="flex flex-col gap-1">
          {NAV.filter((n) => {
            if (n.to === "/users") return canNav("users.manage", isAdmin);
            if (n.to === "/settings") return canNav("settings.manage", isAdmin);
            if (n.to === "/roles") return canNav("roles.manage", isAdmin);
            if (n.to === "/groups") return canNav("groups.manage", isAdmin);
            if (n.to === "/matrix") return canNav("users.manage", isAdmin);
            // The vault listing requires cred.reveal (ADMIN); operators rotate
            // per-VM credentials from the VM detail page instead.
            if (n.to === "/credentials") return canNav("cred.reveal", isAdmin);
            if (n.to === "/jobs") return canNav("jobs.read", privileged);
            if (n.to === "/templates") return canNav("templates.manage", privileged);
            if (n.to === "/audit") return canNav("audit.read", hasAuditRead);
            return true;
          }).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                `px-3 py-2 rounded text-sm ${location.pathname === n.to ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-slate-800"}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto pt-4 border-t border-slate-800">
          <div className="text-sm text-slate-400 mb-2">
            {me.username} <span className="text-slate-500">({me.roles.join(", ")})</span>
          </div>
          <button
            onClick={async () => {
              await logout();
              window.location.href = "/login";
            }}
            className="w-full px-3 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded"
          >
            Log out
          </button>
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-x-auto">
        <Routes>
          <Route path="/" element={<Dashboard me={me} />} />
          <Route path="/vms" element={<Vms me={me} />} />
          <Route path="/vms/:id" element={<VmDetail me={me} />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/guacamole" element={<Guacamole />} />
          <Route path="/credentials" element={<Credentials />} />
          <Route path="/users" element={<Users />} />
          <Route path="/users/:id/permissions" element={<UserPermissions />} />
          <Route path="/roles" element={<Roles />} />
          <Route path="/groups" element={<Groups />} />
          <Route path="/matrix" element={<Matrix />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/jobs" element={<Jobs me={me} />} />
          <Route path="/jobs/:jobId" element={<Jobs me={me} />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/health" element={<Health />} />
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