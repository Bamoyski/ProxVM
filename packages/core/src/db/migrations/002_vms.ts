export const vmsMigration = `
CREATE TABLE vms (
  id UUID PRIMARY KEY,
  vmid INT NOT NULL,
  node TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  os_type TEXT,
  ip_address TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  template_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (vmid, node)
);

CREATE INDEX idx_vms_node ON vms(node);

CREATE TABLE vm_templates (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  node TEXT NOT NULL,
  proxmox_vmid INT NOT NULL,
  os_type TEXT NOT NULL,
  provisioning_method TEXT NOT NULL,
  cloud_init_support BOOLEAN NOT NULL DEFAULT FALSE,
  guest_agent_required BOOLEAN NOT NULL DEFAULT TRUE,
  default_cpu INT NOT NULL DEFAULT 2,
  default_ram_mb INT NOT NULL DEFAULT 2048,
  default_disk_gb INT NOT NULL DEFAULT 20,
  supported_protocols TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (node, proxmox_vmid)
);

CREATE TABLE vm_credentials (
  id UUID PRIMARY KEY,
  vm_id UUID NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL,
  key_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ENCRYPTED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ,
  last_rotated_at TIMESTAMPTZ,
  UNIQUE (vm_id, username)
);

CREATE TABLE guacamole_connections (
  id UUID PRIMARY KEY,
  vm_id UUID NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  hostname TEXT NOT NULL,
  port INT NOT NULL,
  username TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL,
  key_id TEXT NOT NULL,
  guac_connection_name TEXT NOT NULL,
  guac_identifier TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_guac_conn_vm ON guacamole_connections(vm_id);

CREATE TABLE guacamole_users (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guac_username TEXT NOT NULL UNIQUE,
  password_ciphertext TEXT NOT NULL,
  key_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  sync_state TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vm_access (
  vm_id UUID NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vm_id, user_id)
);
`;

export const settingsSeedsVms = ``;