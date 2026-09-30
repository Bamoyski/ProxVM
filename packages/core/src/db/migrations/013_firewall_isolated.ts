export const firewallIsolatedMigration = `
-- Per-VM network-isolation flag. Tracks whether ProxVM applied its
-- default-deny firewall ruleset to the guest. Defaults to false so every
-- existing VM keeps its current (open) networking.
ALTER TABLE vms ADD COLUMN IF NOT EXISTS firewall_isolated BOOLEAN NOT NULL DEFAULT false;
`;
