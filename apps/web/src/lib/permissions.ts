/**
 * Legacy role → permission map, used ONLY as a UI fallback while the
 * backend-resolved effective permission set (/iam/effective) loads or is
 * unreachable. The backend is always the authority; this decides which
 * links render during the first second after boot.
 */

export interface Me {
  id: string;
  username: string;
  roles: string[];
}

const ROLE_PERMS: Record<string, string[]> = {
  ADMIN: [
    "vm.list", "vm.read", "vm.create", "vm.manage", "vm.edit", "vm.delete", "vm.provision",
    "vm.start", "vm.stop", "vm.restart",
    "cred.reveal", "cred.rotate",
    "guac.launch", "guac.manage",
    "users.manage", "roles.manage", "groups.manage", "templates.manage",
    "audit.read",
    "jobs.read", "jobs.retry", "jobs.cancel",
    "settings.manage",
    "health.read",
    "proxmox.read",
  ],
  OPERATOR: [
    "vm.list", "vm.read", "vm.create", "vm.manage", "vm.edit", "vm.provision",
    "cred.rotate",
    "guac.launch", "guac.manage",
    "jobs.read", "jobs.retry", "jobs.cancel",
    "health.read",
    "proxmox.read",
    "templates.manage",
  ],
  USER: ["vm.read", "guac.launch", "jobs.read", "health.read"],
  GUEST: [],
};

export function hasPermission(me: Me | null | undefined, perm: string): boolean {
  if (!me) return false;
  return me.roles.some((r) => ROLE_PERMS[r]?.includes(perm));
}

export function isPrivileged(roles: string[]): boolean {
  return roles.some((r) => r === "ADMIN" || r === "OPERATOR");
}

export function roleTone(role: string): "err" | "warn" | "info" | "neutral" {
  if (role === "ADMIN") return "err";
  if (role === "OPERATOR") return "warn";
  if (role === "USER") return "info";
  return "neutral";
}
