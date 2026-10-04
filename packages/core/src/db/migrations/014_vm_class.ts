export const vmClassMigration = `
-- Per-VM class for idle auto-shutdown policy: 'server' machines are never
-- touched, 'user' machines may be shut down after sustained idleness when
-- the global switch is on. Defaults to 'server' so every existing VM keeps
-- its current behavior. Values are validated in application code (a CHECK
-- here breaks the pg-mem unit-test double).
ALTER TABLE vms ADD COLUMN IF NOT EXISTS vm_class TEXT NOT NULL DEFAULT 'server';
`;
