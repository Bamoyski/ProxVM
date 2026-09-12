export const adminGuardMigration = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_initial_admin BOOLEAN NOT NULL DEFAULT false;

UPDATE users SET is_initial_admin = true
 WHERE id = (
   SELECT ur.user_id FROM user_roles ur
   JOIN roles r ON r.id = ur.role_id
   JOIN users u ON u.id = ur.user_id
   WHERE r.name = 'ADMIN'
   ORDER BY u.created_at ASC, u.id ASC
   LIMIT 1
 )
 AND NOT EXISTS (SELECT 1 FROM users WHERE is_initial_admin = true);

ALTER TABLE vms ADD COLUMN IF NOT EXISTS os_name TEXT;
`;
