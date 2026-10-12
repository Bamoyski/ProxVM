/* ---------------------------------------------------------------------------
 * 001_initial — foundation tables: identity, sessions, audit, settings.
 *
 * Users/roles/user_roles seed the three built-in roles (ADMIN/OPERATOR/USER
 * with fixed UUIDs other migrations rely on); sessions hold hashed sids with
 * expiry indexes for sweeper queries; audit_logs keeps actor refs nullable
 * (SET NULL) so deleting a user never destroys history; settings + the
 * encryption_metadata key registry back the secret-vault rotation flow.
 * Append-only: never edit applied SQL, add a new migration instead.
 * ------------------------------------------------------------------------- */
export const initialMigration = `
-- Identity: users, roles, and their grants (lockout lives on users).
CREATE TABLE users (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  given_name TEXT,
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE roles (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX idx_user_roles_role ON user_roles(role_id);

-- Sessions: one row per login; expiry/user indexes serve the sweeper.
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  sid_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idle_timeout_minutes INT NOT NULL DEFAULT 120,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Audit + app settings: actor refs are SET NULL so user deletion keeps rows.
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  event TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT,
  vm_id UUID,
  job_id UUID,
  ip TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_event ON audit_logs(event);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_vm ON audit_logs(vm_id);

-- Settings vault + master-key registry (rotation reads active flags here).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  encrypted BOOLEAN NOT NULL DEFAULT FALSE,
  category TEXT NOT NULL DEFAULT 'app',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE encryption_metadata (
  key_id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE
);
`;

export const settingsSeeds = `
-- Built-in roles with FIXED UUIDs: later migrations hardcode these ids, so
-- both the ids and names are load-bearing — never regenerate or rename.
INSERT INTO roles (id, name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'ADMIN'),
  ('00000000-0000-0000-0000-000000000002', 'OPERATOR'),
  ('00000000-0000-0000-0000-000000000003', 'USER')
ON CONFLICT (name) DO NOTHING;
`;