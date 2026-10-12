export const pbsBackupsMigration = `
-- PBS backup schedules (one backup timetable per row) and backup run
-- history. Execution is asynchronous and crash-safe: due schedules and
-- manual triggers create PENDING runs; the minute ticker claims them,
-- starts the PVE vzdump task (RUNNING + upid), and a finalizer records
-- OK/FAILED by polling the task. Prune runs work the same way against
-- the PBS API. Nothing here blocks API responses.
CREATE TABLE IF NOT EXISTS pbs_backup_schedules (
  id UUID PRIMARY KEY,
  vm_id UUID NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'snapshot',
  storage TEXT NOT NULL,
  datastore TEXT NULL,
  minute SMALLINT NOT NULL,
  hour SMALLINT NOT NULL,
  days TEXT NOT NULL DEFAULT '*',
  keep_last INT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ NULL,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pbs_backup_schedules_enabled ON pbs_backup_schedules(enabled);
CREATE INDEX IF NOT EXISTS idx_pbs_backup_schedules_vm ON pbs_backup_schedules(vm_id);

CREATE TABLE IF NOT EXISTS pbs_backups (
  id UUID PRIMARY KEY,
  vm_id UUID NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
  schedule_id UUID NULL REFERENCES pbs_backup_schedules(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'backup',
  mode TEXT NOT NULL DEFAULT 'snapshot',
  storage TEXT NOT NULL DEFAULT '',
  datastore TEXT NULL,
  keep_last INT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  upid TEXT NULL,
  error TEXT NULL,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_pbs_backups_status ON pbs_backups(status);
CREATE INDEX IF NOT EXISTS idx_pbs_backups_vm ON pbs_backups(vm_id);
`;
