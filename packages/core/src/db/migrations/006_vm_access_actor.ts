export const vmAccessActorMigration = `
ALTER TABLE vm_access ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
`;
