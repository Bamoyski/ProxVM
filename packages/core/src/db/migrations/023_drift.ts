export const driftMigration = `
-- Ground-truth drift: persisted findings with a lifecycle, unlike the
-- stateless threats page. One row per deterministic fingerprint (UNIQUE):
-- a re-detected drift re-opens the same row (status back to OPEN and
-- occurrences incremented) instead of spawning duplicates, and an
-- auto-resolved row keeps its resolved_at/occurrences as history.
-- drift_vm_state is per-VM bookkeeping, not findings: credential-probe
-- cooldowns plus the last-seen hardware snapshot baseline (cores/memory/net
-- are NOT modeled in the vms table, so hardware drift is pass-to-pass:
-- each pass fetches qemuConfig and diffs against the stored snapshot;
-- in-band edits refresh the snapshot after Proxmox accepts).
CREATE TABLE IF NOT EXISTS drift_findings (
  id UUID PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  dimension TEXT NOT NULL,
  severity TEXT NOT NULL,
  vm_id UUID NULL REFERENCES vms(id) ON DELETE CASCADE,
  connection_id TEXT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'OPEN',
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ NULL,
  acknowledged_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ NULL,
  resolved_reason TEXT NULL,
  remediated_at TIMESTAMPTZ NULL,
  remediated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drift_findings_status ON drift_findings(status, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_drift_findings_vm ON drift_findings(vm_id) WHERE vm_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS drift_vm_state (
  vm_id UUID PRIMARY KEY REFERENCES vms(id) ON DELETE CASCADE,
  last_probe_at TIMESTAMPTZ NULL,
  last_probe_ok_at TIMESTAMPTZ NULL,
  cores INTEGER NULL,
  memory_mb INTEGER NULL,
  net_json TEXT NULL,
  snapshotted_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
