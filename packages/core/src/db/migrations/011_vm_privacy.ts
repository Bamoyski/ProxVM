export const vmPrivacyMigration = `
-- Per-VM privacy flag. When set, the legacy ADMIN/OPERATOR access bypass
-- does NOT apply: every user, including administrators, needs a concrete
-- (direct or group, unexpired) grant to see or manage the VM. Defaults to
-- false so existing VMs keep their current visibility.
ALTER TABLE vms ADD COLUMN IF NOT EXISTS privacy_flag BOOLEAN NOT NULL DEFAULT false;
`;
