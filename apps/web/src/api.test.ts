import { describe, it, expect } from "vitest";
import { ApiRequestError, explainDenial, friendlyHttpMessage } from "./api.js";

/**
 * Error rendering is the only feedback a user gets when something breaks, so
 * each backend denial reason must map to a specific, actionable sentence —
 * and never to a raw stack trace or an undefined string.
 */
describe("explainDenial", () => {
  it("renders missing_permission naming the permission", () => {
    const err = new ApiRequestError("FORBIDDEN", "denied", 403, {
      allowed: false,
      reason: "missing_permission",
      permission: "vm.delete",
    });
    expect(explainDenial(err)).toBe("Missing permission: vm.delete.");
  });

  it("joins multiple acceptable permissions with 'or'", () => {
    const err = new ApiRequestError("FORBIDDEN", "denied", 403, {
      allowed: false,
      reason: "missing_permission",
      permission: ["vm.manage", "vm.edit"],
    });
    expect(explainDenial(err)).toBe("Missing permission: vm.manage or vm.edit.");
  });

  it("falls back to a generic phrase when no permission is named", () => {
    const err = new ApiRequestError("FORBIDDEN", "denied", 403, {
      allowed: false,
      reason: "missing_permission",
    });
    expect(explainDenial(err)).toBe("Missing permission: the required permission.");
  });

  it("renders each known denial reason", () => {
    const cases: Array<[string, string]> = [
      ["missing_vm_access", "No access to this VM. Ask an administrator to grant it."],
      ["access_expired", "Your access to this VM has expired. Ask an administrator to renew it."],
      ["inactive_user", "Your account is disabled."],
    ];
    for (const [reason, expected] of cases) {
      const err = new ApiRequestError("FORBIDDEN", "denied", 403, { allowed: false, reason });
      expect(explainDenial(err), reason).toBe(expected);
    }
  });

  it("names the protocol requirement for protocol_denied", () => {
    const err = new ApiRequestError("FORBIDDEN", "denied", 403, {
      allowed: false,
      reason: "protocol_denied",
      permission: "rdp",
    });
    expect(explainDenial(err)).toBe("This protocol is not enabled for you (requires rdp).");
  });

  it("returns null for allowed explanations, plain errors, and unknown reasons", () => {
    expect(explainDenial(new ApiRequestError("X", "m", 403, { allowed: true, reason: "missing_permission" }))).toBeNull();
    expect(explainDenial(new Error("boom"))).toBeNull();
    expect(explainDenial("a string")).toBeNull();
    expect(explainDenial(undefined)).toBeNull();
    expect(explainDenial(new ApiRequestError("X", "m", 403, { allowed: false, reason: "brand_new_reason" }))).toBeNull();
  });
});

describe("friendlyHttpMessage", () => {
  it("maps proxy/edge failures to a retry hint", () => {
    for (const code of [502, 503, 504]) {
      expect(friendlyHttpMessage(code)).toMatch(/briefly unavailable/);
    }
    expect(friendlyHttpMessage(524)).toMatch(/still running/);
  });

  it("maps auth expiry and rate limiting to actionable text", () => {
    expect(friendlyHttpMessage(401)).toMatch(/session expired/);
    expect(friendlyHttpMessage(404)).toMatch(/deleted/);
    expect(friendlyHttpMessage(429)).toMatch(/Too many attempts/);
  });

  it("covers every other 5xx with a server-side message", () => {
    expect(friendlyHttpMessage(500)).toMatch(/on the server/);
    expect(friendlyHttpMessage(599)).toMatch(/on the server/);
  });

  it("covers other client errors generically", () => {
    expect(friendlyHttpMessage(400)).toMatch(/Request failed/);
    expect(friendlyHttpMessage(418)).toMatch(/Request failed/);
  });
});

describe("ApiRequestError", () => {
  it("carries code, status, and explanation for the UI to branch on", () => {
    const err = new ApiRequestError("QUOTA", "too many VMs", 409, {
      allowed: false,
      reason: "missing_permission",
      permission: "vm.create",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("QUOTA");
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe("too many VMs");
    expect(err.explanation?.reason).toBe("missing_permission");
  });

  it("defaults explanation to null when the server sends none", () => {
    expect(new ApiRequestError("X", "m", 500).explanation).toBeNull();
  });
});
