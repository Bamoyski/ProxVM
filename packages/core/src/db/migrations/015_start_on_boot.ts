export const startOnBootMigration = `
-- Per-VM start-on-host-boot flag. Tracks whether ProxVM set the Proxmox
-- native 'onboot' flag on the guest, so the VM powers on automatically when
-- its Proxmox node boots. Defaults to false so every existing VM keeps its
-- current behavior (Proxmox default is off).
ALTER TABLE vms ADD COLUMN IF NOT EXISTS start_on_boot BOOLEAN NOT NULL DEFAULT false;
`;
