export const homelabMigration = `
-- Scheduled power actions (start/stop/restart) evaluated every minute.
-- days is '*' (daily) or a comma list of weekday numbers (0=Sunday).
CREATE TABLE IF NOT EXISTS vm_schedules (
  id UUID PRIMARY KEY,
  vm_id UUID NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  minute SMALLINT NOT NULL,
  hour SMALLINT NOT NULL,
  days TEXT NOT NULL DEFAULT '*',
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ NULL,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vm_schedules_enabled ON vm_schedules(enabled);

-- Time-boxed, revocable share links for Guacamole sessions. The token itself
-- carries no Guacamole credential: redeeming mints a fresh token server-side.
CREATE TABLE IF NOT EXISTS shared_links (
  id UUID PRIMARY KEY,
  vm_id UUID NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses INT NULL,
  use_count INT NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ NULL,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shared_links_token ON shared_links(token_hash);

-- Discovered network services per VM (port scan snapshots).
CREATE TABLE IF NOT EXISTS vm_services (
  vm_id UUID NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
  port INT NOT NULL,
  service TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vm_id, port)
);

-- Last known connection health per VM/protocol (periodic checker).
CREATE TABLE IF NOT EXISTS connection_health (
  vm_id UUID NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  reachable BOOLEAN NOT NULL,
  authenticated BOOLEAN NULL,
  detail TEXT NOT NULL DEFAULT '',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vm_id, protocol)
);
`;
