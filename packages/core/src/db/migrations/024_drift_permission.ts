// ---------------------------------------------------------------------------
// 024_drift_permission — make drift.manage grantable.
//
// PERMISSIONS (rbac.ts) is the compile-time catalog, but grants are enforced by
// foreign keys into the permissions TABLE (role_permissions/user_permissions).
// Without this row a custom role or direct grant naming drift.manage fails the
// FK, so the permission was effectively ADMIN-only despite the documented
// "grant it explicitly" contract.
// ---------------------------------------------------------------------------
export const driftPermissionMigration = `
INSERT INTO permissions (code, category, description, scope) VALUES
  ('drift.manage', 'System', 'Review and remediate ground-truth drift findings', 'global')
ON CONFLICT (code) DO NOTHING;
`;
