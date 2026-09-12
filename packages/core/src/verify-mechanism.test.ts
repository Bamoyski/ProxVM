import { describe, expect, it } from "vitest";
import { portForVerifyMechanism, selectVerifyMechanism } from "./index.js";

describe("guest verification mechanism selection", () => {
  it("prefers real SSH authentication whenever SSH is selected", () => {
    expect(selectVerifyMechanism(["ssh"], "linux")).toBe("ssh");
    expect(selectVerifyMechanism(["ssh", "rdp"], "linux")).toBe("ssh");
    expect(selectVerifyMechanism(["ssh", "vnc"], "linux")).toBe("ssh");
    expect(selectVerifyMechanism(["ssh"], "windows")).toBe("ssh");
  });

  it("uses transport checks matching the selected protocols otherwise", () => {
    // RDP-only Linux guests (e.g. xrdp without sshd) must not be SSH-verified.
    expect(selectVerifyMechanism(["rdp"], "linux")).toBe("rdp-port");
    expect(selectVerifyMechanism(["vnc"], "linux")).toBe("vnc-port");
    expect(selectVerifyMechanism(["rdp"], "windows")).toBe("rdp-port");
    expect(selectVerifyMechanism(["rdp", "vnc"], "windows")).toBe("rdp-port");
  });

  it("maps mechanisms to the right ports", () => {
    expect(portForVerifyMechanism("ssh")).toBe(22);
    expect(portForVerifyMechanism("rdp-port")).toBe(3389);
    expect(portForVerifyMechanism("vnc-port")).toBe(5900);
  });
});
