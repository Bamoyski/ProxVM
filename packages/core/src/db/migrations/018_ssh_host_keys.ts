export const sshHostKeysMigration = `
-- TOFU SSH host-key pinning store. Each row pins the SHA-256 fingerprint of
-- the SSH host key presented by a VM (or, for VM-less endpoint probes, the
-- endpoint) on the first authenticated connection. scope is the uniqueness
-- key the application computes ("vm:<uuid>@host:port" or "host:host:port"),
-- so INSERT ... ON CONFLICT (scope) DO NOTHING is the atomic first-enrollment
-- primitive. Fingerprints are public key material (defense against MITM, not
-- confidential), so no encryption-at-rest is applied; the value is still only
-- ever overwritten by the Admin "rotate host key" path or by re-enrollment
-- after an unpin, never by connections themselves.
CREATE TABLE ssh_host_keys (
  id UUID PRIMARY KEY,
  scope TEXT NOT NULL UNIQUE,
  vm_id UUID REFERENCES vms(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  key_type TEXT,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ssh_host_keys_vm ON ssh_host_keys(vm_id);
`;