export const guacDirectLoginMigration = `
-- Per-user direct Guacamole logins (opt-in, admin-managed). Most users only
-- ever enter Guacamole through ProxVM's token-minting launch flow with a
-- random unknown password; setting direct_login_enabled means an admin
-- deliberately gave this user a KNOWN Guacamole password so they can sign
-- in at the Guacamole web UI directly. Disabling rotates back to a fresh
-- random unknown password. Revocation path: disable here, or disable/delete
-- the ProxVM user (existing suspend/remove flows are untouched).
ALTER TABLE guacamole_users ADD COLUMN IF NOT EXISTS direct_login_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE guacamole_users ADD COLUMN IF NOT EXISTS direct_login_set_at TIMESTAMPTZ NULL;
`;
