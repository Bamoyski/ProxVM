export const vmIpUniqueMigration = `
-- Static-IP allocation integrity. ip_static marks addresses an operator
-- asserted (static provisioning config or manual override); discovered
-- (DHCP/agent) addresses stay non-static and may legitimately repeat across
-- rows (stale records, DHCP churn). Only static assignments are unique: the
-- partial index serializes allocation races that the application pre-check
-- cannot see, while discovery writes never trip it.
ALTER TABLE vms ADD COLUMN IF NOT EXISTS ip_static BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vms_ip_address_static
  ON vms (ip_address)
  WHERE deleted_at IS NULL AND ip_address IS NOT NULL AND ip_static IS TRUE;
`;
