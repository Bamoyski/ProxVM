import { describe, it, expect } from "vitest";
import { hasPermission, isPrivileged, roleTone, type Me } from "./permissions.js";

/**
 * This map is the UI's *fallback* while the backend-resolved effective
 * permission set loads. It must be conservative: it decides which controls
 * render during the first second after boot, and the backend always remains
 * the authority (a wrong "yes" here still fails server-side, but a wrong
 * "no" would hide a control the user actually has).
 */
const admin: Me = { id: "1", username: "root", roles: ["ADMIN"] };
const operator: Me = { id: "2", username: "op", roles: ["OPERATOR"] };
const user: Me = { id: "3", username: "u", roles: ["USER"] };
const guest: Me = { id: "4", username: "g", roles: ["GUEST"] };

describe("hasPermission", () => {
  it("grants admins every checked permission", () => {
    for (const p of ["vm.delete", "users.manage", "settings.manage", "audit.read", "cred.reveal"]) {
      expect(hasPermission(admin, p), p).toBe(true);
    }
  });

  it("denies operators destructive and admin-only permissions", () => {
    expect(hasPermission(operator, "vm.delete")).toBe(false);
    expect(hasPermission(operator, "users.manage")).toBe(false);
    expect(hasPermission(operator, "settings.manage")).toBe(false);
  });

  it("allows operators to manage and rotate", () => {
    expect(hasPermission(operator, "vm.create")).toBe(true);
    expect(hasPermission(operator, "vm.manage")).toBe(true);
    expect(hasPermission(operator, "cred.rotate")).toBe(true);
  });

  it("gives plain users only their read/launch surface", () => {
    expect(hasPermission(user, "vm.read")).toBe(true);
    expect(hasPermission(user, "guac.launch")).toBe(true);
    expect(hasPermission(user, "vm.create")).toBe(false);
    expect(hasPermission(user, "cred.reveal")).toBe(false);
  });

  it("gives guests nothing (self-serve signups hold zero permissions)", () => {
    for (const p of ["vm.list", "vm.read", "guac.launch", "health.read"]) {
      expect(hasPermission(guest, p), p).toBe(false);
    }
  });

  it("treats a multi-role user as the union of those roles", () => {
    expect(hasPermission({ id: "5", username: "mix", roles: ["USER", "OPERATOR"] }, "vm.delete")).toBe(false);
    expect(hasPermission({ id: "5", username: "mix", roles: ["USER", "OPERATOR"] }, "vm.create")).toBe(true);
  });

  it("returns false for missing/unknown users and unknown roles", () => {
    expect(hasPermission(null, "vm.read")).toBe(false);
    expect(hasPermission(undefined, "vm.read")).toBe(false);
    expect(hasPermission({ id: "6", username: "x", roles: ["NONSENSE"] }, "vm.read")).toBe(false);
  });
});

describe("isPrivileged", () => {
  it("is true only for ADMIN and OPERATOR", () => {
    expect(isPrivileged(["ADMIN"])).toBe(true);
    expect(isPrivileged(["OPERATOR"])).toBe(true);
    expect(isPrivileged(["USER"])).toBe(false);
    expect(isPrivileged(["GUEST"])).toBe(false);
    expect(isPrivileged([])).toBe(false);
    expect(isPrivileged(["USER", "OPERATOR"])).toBe(true);
  });
});

describe("roleTone", () => {
  it("assigns a distinct tone per role for badge rendering", () => {
    expect(roleTone("ADMIN")).toBe("err");
    expect(roleTone("OPERATOR")).toBe("warn");
    expect(roleTone("USER")).toBe("info");
    expect(roleTone("GUEST")).toBe("neutral");
    expect(roleTone("anything-else")).toBe("neutral");
  });
});
