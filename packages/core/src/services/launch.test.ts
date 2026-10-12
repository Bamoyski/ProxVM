import { describe, expect, it, vi } from "vitest";
import { startVmForLaunchIfStopped } from "./launch.js";

describe("startVmForLaunchIfStopped", () => {
  it("starts a stopped VM and waits for Proxmox to finish", async () => {
    const proxmox = {
      qemuStatus: vi.fn().mockResolvedValue({ status: "stopped" }),
      start: vi.fn().mockResolvedValue("UPID:node:task"),
      waitForTask: vi.fn().mockResolvedValue(undefined),
    };

    await expect(startVmForLaunchIfStopped(proxmox as never, { node: "node1", vmid: 101 })).resolves.toBe(true);
    expect(proxmox.start).toHaveBeenCalledWith("node1", 101);
    expect(proxmox.waitForTask).toHaveBeenCalledWith("node1", "UPID:node:task", 120000);
  });

  it("skips the task wait when start yields no upid", async () => {
    const proxmox = {
      qemuStatus: vi.fn().mockResolvedValue({ status: "stopped" }),
      start: vi.fn().mockResolvedValue(""),
      waitForTask: vi.fn(),
    };

    await expect(startVmForLaunchIfStopped(proxmox as never, { node: "node1", vmid: 101 })).resolves.toBe(true);
    expect(proxmox.start).toHaveBeenCalled();
    expect(proxmox.waitForTask).not.toHaveBeenCalled();
  });

  it("leaves an already-running VM alone", async () => {
    const proxmox = {
      qemuStatus: vi.fn().mockResolvedValue({ status: "running" }),
      start: vi.fn(),
      waitForTask: vi.fn(),
    };

    await expect(startVmForLaunchIfStopped(proxmox as never, { node: "node1", vmid: 101 })).resolves.toBe(false);
    expect(proxmox.start).not.toHaveBeenCalled();
    expect(proxmox.waitForTask).not.toHaveBeenCalled();
  });
});
