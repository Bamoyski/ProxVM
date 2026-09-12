export const iamMigration = `
-- Roles: describe custom/preset roles; built-ins are protected (is_system).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
UPDATE roles SET is_system = true WHERE name IN ('ADMIN', 'OPERATOR', 'USER');

-- Temporary role assignments.
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS granted_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Permission catalog: every code here is enforced somewhere by the backend.
-- scope is informational for the UI (global vs protocol).
CREATE TABLE IF NOT EXISTS permissions (
  code TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global'
);

INSERT INTO permissions (code, category, description, scope) VALUES
  ('vm.list', 'Virtual Machines', 'List virtual machines', 'global'),
  ('vm.read', 'Virtual Machines', 'View virtual machine details', 'global'),
  ('vm.create', 'Virtual Machines', 'Open the provisioning flow (Basic/Advanced)', 'global'),
  ('vm.manage', 'Virtual Machines', 'Start, stop and restart any VM', 'global'),
  ('vm.edit', 'Virtual Machines', 'Edit VM resources and manage user access', 'global'),
  ('vm.delete', 'Virtual Machines', 'Delete virtual machines', 'global'),
  ('vm.provision', 'Virtual Machines', 'Provision VMs from templates', 'global'),
  ('vm.start', 'Virtual Machines', 'Start assigned VMs', 'global'),
  ('vm.stop', 'Virtual Machines', 'Stop assigned VMs', 'global'),
  ('vm.restart', 'Virtual Machines', 'Restart assigned VMs', 'global'),
  ('cred.reveal', 'Credentials', 'Reveal VM credentials', 'global'),
  ('cred.rotate', 'Credentials', 'Rotate VM credentials', 'global'),
  ('guac.launch', 'Remote Access', 'Launch Guacamole sessions for assigned VMs', 'global'),
  ('guac.manage', 'Remote Access', 'Manage Guacamole connections', 'global'),
  ('protocol.ssh', 'Remote Access', 'Use SSH on accessible VMs', 'protocol'),
  ('protocol.rdp', 'Remote Access', 'Use RDP on accessible VMs', 'protocol'),
  ('protocol.vnc', 'Remote Access', 'Use VNC on accessible VMs', 'protocol'),
  ('users.manage', 'Users & Access', 'Manage users', 'global'),
  ('roles.manage', 'Users & Access', 'Manage roles and permission grants', 'global'),
  ('groups.manage', 'Users & Access', 'Manage groups and memberships', 'global'),
  ('templates.manage', 'System', 'Manage VM templates', 'global'),
  ('audit.read', 'System', 'Read the audit log', 'global'),
  ('jobs.read', 'Jobs', 'View provisioning jobs', 'global'),
  ('jobs.retry', 'Jobs', 'Retry failed provisioning jobs', 'global'),
  ('jobs.cancel', 'Jobs', 'Cancel provisioning jobs', 'global'),
  ('settings.manage', 'System', 'Manage system settings', 'global'),
  ('health.read', 'System', 'View system health', 'global'),
  ('proxmox.read', 'System', 'View Proxmox cluster information', 'global')
ON CONFLICT (code) DO NOTHING;

-- Custom/preset role -> permission grants.
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission)
);

-- Legacy roles must exist even on fresh installs: ensureSeeded() only inserts
-- them when roles is empty, but the preset seeds below would make it non-empty.
INSERT INTO roles (id, name, description, is_system) VALUES
  ('00000000-0000-0000-0000-000000000001', 'ADMIN', 'Full system access', true),
  ('00000000-0000-0000-0000-000000000002', 'OPERATOR', 'Operate and provision VMs', true),
  ('00000000-0000-0000-0000-000000000003', 'USER', 'Access assigned VMs', true)
ON CONFLICT (id) DO NOTHING;

-- Built-in presets (protected: is_system = true). Legacy ADMIN/OPERATOR/USER
-- keep their hardcoded permission sets; presets compose the same catalog.
INSERT INTO roles (id, name, description, is_system) VALUES
  ('00000000-0000-0000-0000-000000000101', 'Viewer', 'Read-only VM and job visibility', true),
  ('00000000-0000-0000-0000-000000000102', 'VM Operator', 'Operate assigned VMs and remote access', true),
  ('00000000-0000-0000-0000-000000000103', 'VM Manager', 'Operator plus VM editing and access management', true),
  ('00000000-0000-0000-0000-000000000104', 'Provisioner', 'Provision and manage new VMs', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission) VALUES
  ('00000000-0000-0000-0000-000000000101', 'vm.list'),
  ('00000000-0000-0000-0000-000000000101', 'vm.read'),
  ('00000000-0000-0000-0000-000000000101', 'jobs.read'),
  ('00000000-0000-0000-0000-000000000101', 'health.read'),
  ('00000000-0000-0000-0000-000000000102', 'vm.list'),
  ('00000000-0000-0000-0000-000000000102', 'vm.read'),
  ('00000000-0000-0000-0000-000000000102', 'vm.start'),
  ('00000000-0000-0000-0000-000000000102', 'vm.stop'),
  ('00000000-0000-0000-0000-000000000102', 'vm.restart'),
  ('00000000-0000-0000-0000-000000000102', 'jobs.read'),
  ('00000000-0000-0000-0000-000000000102', 'health.read'),
  ('00000000-0000-0000-0000-000000000102', 'protocol.ssh'),
  ('00000000-0000-0000-0000-000000000102', 'protocol.rdp'),
  ('00000000-0000-0000-0000-000000000102', 'protocol.vnc'),
  ('00000000-0000-0000-0000-000000000103', 'vm.list'),
  ('00000000-0000-0000-0000-000000000103', 'vm.read'),
  ('00000000-0000-0000-0000-000000000103', 'vm.start'),
  ('00000000-0000-0000-0000-000000000103', 'vm.stop'),
  ('00000000-0000-0000-0000-000000000103', 'vm.restart'),
  ('00000000-0000-0000-0000-000000000103', 'vm.edit'),
  ('00000000-0000-0000-0000-000000000103', 'jobs.read'),
  ('00000000-0000-0000-0000-000000000103', 'health.read'),
  ('00000000-0000-0000-0000-000000000103', 'protocol.ssh'),
  ('00000000-0000-0000-0000-000000000103', 'protocol.rdp'),
  ('00000000-0000-0000-0000-000000000103', 'protocol.vnc'),
  ('00000000-0000-0000-0000-000000000104', 'vm.list'),
  ('00000000-0000-0000-0000-000000000104', 'vm.read'),
  ('00000000-0000-0000-0000-000000000104', 'vm.create'),
  ('00000000-0000-0000-0000-000000000104', 'vm.provision'),
  ('00000000-0000-0000-0000-000000000104', 'vm.start'),
  ('00000000-0000-0000-0000-000000000104', 'vm.stop'),
  ('00000000-0000-0000-0000-000000000104', 'vm.restart'),
  ('00000000-0000-0000-0000-000000000104', 'vm.edit'),
  ('00000000-0000-0000-0000-000000000104', 'jobs.read'),
  ('00000000-0000-0000-0000-000000000104', 'jobs.retry'),
  ('00000000-0000-0000-0000-000000000104', 'jobs.cancel'),
  ('00000000-0000-0000-0000-000000000104', 'health.read'),
  ('00000000-0000-0000-0000-000000000104', 'proxmox.read')
ON CONFLICT DO NOTHING;

-- Direct per-user global permission grants (may expire).
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NULL,
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, permission)
);
CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);

-- Groups and inheritance.
CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NULL,
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE TABLE IF NOT EXISTS group_roles (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NULL,
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_group_roles_group ON group_roles(group_id);

-- Protocol scoping + expiry on direct VM access (NULL protocols = all).
ALTER TABLE vm_access ADD COLUMN IF NOT EXISTS protocols TEXT[] NULL;
ALTER TABLE vm_access ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;

-- Group VM access (inherited by unexpired members).
CREATE TABLE IF NOT EXISTS group_vm_access (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  vm_id UUID NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
  protocols TEXT[] NULL,
  expires_at TIMESTAMPTZ NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, vm_id)
);
CREATE INDEX IF NOT EXISTS idx_group_vm_access_group ON group_vm_access(group_id);
CREATE INDEX IF NOT EXISTS idx_group_vm_access_vm ON group_vm_access(vm_id);
`;
