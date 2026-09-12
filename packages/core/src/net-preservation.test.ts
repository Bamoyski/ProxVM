import { describe, expect, it } from "vitest";
import { buildNet, extraNetOptions } from "./index.js";

describe("template NIC option preservation", () => {
  it("plain NICs build exactly as before (no behavior change)", () => {
    expect(buildNet("virtio", "AA:BB:CC:DD:EE:FF", "vmbr0")).toBe(
      "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0",
    );
    expect(buildNet("virtio", null, "vmbr0", 10)).toBe("virtio,bridge=vmbr0,tag=10");
  });

  it("template flags like firewall/mtu survive a bridge change", () => {
    const raw = "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr1,firewall=1,mtu=1400";
    const extra = extraNetOptions(raw, "virtio");
    expect(extra).toEqual(["firewall=1", "mtu=1400"]);
    expect(buildNet("virtio", "AA:BB:CC:DD:EE:FF", "vmbr0", undefined, extra)).toBe(
      "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1,mtu=1400",
    );
  });

  it("managed keys (bridge/tag/model/macaddr) are never duplicated", () => {
    const raw = "model=virtio,macaddr=AA:BB,bridge=vmbr1,tag=5,firewall=1";
    expect(extraNetOptions(raw, "virtio")).toEqual(["firewall=1"]);
  });

  it("empty or missing config yields no extras", () => {
    expect(extraNetOptions(null, "virtio")).toEqual([]);
    expect(extraNetOptions("", "virtio")).toEqual([]);
    expect(extraNetOptions("virtio=AA:BB,bridge=vmbr0", "virtio")).toEqual([]);
  });
});
