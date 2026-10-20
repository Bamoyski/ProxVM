import { describe, it, expect } from "vitest";
import { statusTone } from "../ui/feedback.js";

/**
 * Every status string the backend can emit must map to a deterministic tone.
 * The design rule is "status = dot + text, never color alone", but the dot
 * color still has to be right: errors red, transitional amber, success green.
 */
describe("statusTone", () => {
  it("maps healthy/ready states to ok", () => {
    for (const s of ["running", "READY", "VERIFIED", "ONLINE", "online", "OK", "ok", "connected", "approved", "ACTIVE"]) {
      expect(statusTone(s), s).toBe("ok");
    }
  });

  it("maps failure states to err", () => {
    for (const s of ["failed", "FAILED", "error", "ERROR", "OFFLINE", "disconnected", "REJECTED", "rejected"]) {
      expect(statusTone(s), s).toBe("err");
    }
  });

  it("maps transitional states to warn", () => {
    for (const s of ["starting", "stopping", "QUEUED", "PROVISIONING", "migrating", "rotating", "some-new-backend-state"]) {
      expect(statusTone(s), s).toBe("warn");
    }
  });

  it("maps neutral/idle states to none", () => {
    for (const s of ["stopped", "unknown", "PENDING", "CLOSED", "closed", "CANCELLED", "UNCONFIGURED"]) {
      expect(statusTone(s), s).toBe("none");
    }
  });

  it("never throws on null/undefined", () => {
    expect(statusTone(null)).toBe("none");
    expect(statusTone(undefined)).toBe("none");
  });

  it("treats RUNNING as an interactive-but-neutral info state", () => {
    expect(statusTone("RUNNING")).toBe("info");
    expect(statusTone("running-pending")).toBe("info");
  });
});
