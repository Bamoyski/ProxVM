// ---------------------------------------------------------------------------
// Add backup_id column to pbs_backups. Restore runs store the PBS backup
// ID (e.g. "pbs:backup/2026-10-28T12:00:00Z") here; backup/prune runs
// leave it NULL. No backfill needed — restore is opt-in and no existing
// runs carry a backup_id.
// ---------------------------------------------------------------------------
export const pbsBackupRestoreMigration = `
ALTER TABLE pbs_backups ADD COLUMN IF NOT EXISTS backup_id TEXT;
ALTER TABLE pbs_backups ADD COLUMN IF NOT EXISTS restore_name TEXT;
`;
