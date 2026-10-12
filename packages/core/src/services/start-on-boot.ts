import type { ProxmoxClient } from "../proxmox/client.js";
import type { VmsRepository } from "./vms.js";

/**
 * Start-on-host-boot, backed by Proxmox's native `onboot` guest flag.
 * Proxmox itself starts flagged guests when their node boots (in `order`
 * sequence when set), so no ProxVM-side polling is needed — this helper
 * only keeps the flag in sync and persists the desired state.
 *
 * The Proxmox config change applies synchronously (no task to wait for);
 * the DB row is written only after Proxmox accepts the flag, so the two
 * never disagree after a successful call. Throws on Proxmox errors and
 * leaves the DB untouched in that case.
 */
export async function applyStartOnBoot(
  proxmox: Pick<ProxmoxClient, "updateConfig">,
  vms: Pick<VmsRepository, "setStartOnBoot">,
  vm: { id: string; node: string; vmid: number },
  enabled: boolean,
): Promise<void> {
  await proxmox.updateConfig(vm.node, vm.vmid, { onboot: enabled ? 1 : 0 });
  await vms.setStartOnBoot(vm.id, enabled);
}
