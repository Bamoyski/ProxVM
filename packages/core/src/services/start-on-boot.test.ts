import { describe, expect, it, vi } from "vitest";
import { applyStartOnBoot } from "./start-on-boot.js";

describe("applyStartOnBoot", () => {
  it("sets the Proxmox onboot flag and persists the desired state", async () => {
    const proxmox = { updateConfig: vi.fn().mockResolvedValue("") };
    const vms = { setStartOnBoot: vi.fn().mockResolvedValue(undefined) };
    const vm = { id: "vm-1", node: "node1", vmid: 101 };

    await applyStartOnBoot(proxmox as never, vms as never, vm, true);
    expect(proxmox.updateConfig).toHaveBeenCalledWith("node1", 101, { onboot: 1 });
    expect(vms.setStartOnBoot).toHaveBeenCalledWith("vm-1", true);

    await applyStartOnBoot(proxmox as never, vms as never, vm, false);
    expect(proxmox.updateConfig).toHaveBeenCalledWith("node1", 101, { onboot: 0 });
    expect(vms.setStartOnBoot).toHaveBeenCalledWith("vm-1", false);
  });

  it("leaves the DB untouched when Proxmox rejects the flag", async () => {
    const proxmox = { updateConfig: vi.fn().mockRejectedValue(new Error("no such VM")) };
    const vms = { setStartOnBoot: vi.fn() };

    await expect(
      applyStartOnBoot(proxmox as never, vms as never, { id: "vm-1", node: "node1", vmid: 101 }, true),
    ).rejects.toThrow("no such VM");
    expect(vms.setStartOnBoot).not.toHaveBeenCalled();
  });
});
