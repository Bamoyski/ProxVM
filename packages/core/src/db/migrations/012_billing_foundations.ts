export const billingFoundationsMigration = `
-- Billing foundations: usage metering, per-user quotas, support tickets.
-- Everything defaults to inert (no limits, no tickets, no metering rows)
-- so existing installs see zero behavior change.

-- Power-state periods per VM. ended_at NULL means currently running.
-- Rows are written only on running/stopped transitions (reconciled from the
-- Proxmox power state, so out-of-band changes are billed too), never polled.
CREATE TABLE IF NOT EXISTS vm_power_periods (
  id UUID PRIMARY KEY,
  vm_id UUID NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS vm_power_periods_vm_started_idx
  ON vm_power_periods (vm_id, started_at);

-- Per-user VM quota. NULL (the default for everyone) means unlimited.
-- Bounds are enforced in setUserQuota, not here: pg-mem cannot parse a
-- self-referencing CHECK on ADD COLUMN, and unit tests must run.
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_vms INTEGER NULL;

-- Support tickets: filed by any authenticated user, closed by admins.
CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL CHECK (title <> ''),
  body TEXT NOT NULL CHECK (body <> ''),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ NULL,
  closed_by UUID NULL REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS support_tickets_status_created_idx
  ON support_tickets (status, created_at);
CREATE INDEX IF NOT EXISTS support_tickets_user_idx
  ON support_tickets (user_id, created_at);
`;
