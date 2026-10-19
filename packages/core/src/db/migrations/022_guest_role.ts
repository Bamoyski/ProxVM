/* ---------------------------------------------------------------------------
 * 022_guest_role — the self-serve signup role.
 *
 * GUEST is the automatic landing role for auto-approved registrations: it
 * confers NOTHING (no permission rows are seeded), so a fresh account can
 * authenticate and see its own session only until an administrator assigns
 * real roles. is_system=true keeps it undeletable — the register endpoint
 * references it by name and must never depend on it existing manually.
 * ------------------------------------------------------------------------- */
export const guestRoleMigration = `
INSERT INTO roles (id, name, description, is_system) VALUES
  ('00000000-0000-0000-0000-000000000004', 'GUEST', 'Self-serve account with no VM access until an administrator grants roles', true)
ON CONFLICT (id) DO NOTHING;
UPDATE roles SET is_system = true, description = 'Self-serve account with no VM access until an administrator grants roles' WHERE name = 'GUEST';
`;
