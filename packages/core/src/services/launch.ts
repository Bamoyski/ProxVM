import type { ProxmoxClient } from "../proxmox/client.js";

/**
 * Starts a stopped VM before a remote-session launch.  This deliberately
 * checks Proxmox rather than the locally cached VM status, because power
 * state may have changed outside ProxVM.
 *
 * Returns true only when this launch initiated a start.  Waiting for the
 * Proxmox task ensures QEMU is running before Guacamole receives its URL;
 * guest services may still take their normal boot time to accept a session.
 */
export async function startVmForLaunchIfStopped(
  proxmox: Pick<ProxmoxClient, "qemuStatus" | "start" | "waitForTask">,
  vm: { node: string; vmid: number },
): Promise<boolean> {
  const status = await proxmox.qemuStatus(vm.node, vm.vmid);
  if (String(status.status ?? "").toLowerCase() !== "stopped") return false;

  const upid = await proxmox.start(vm.node, vm.vmid);
  if (upid) await proxmox.waitForTask(vm.node, upid, 120000);
  return true;
}
