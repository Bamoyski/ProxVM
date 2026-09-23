export const registrationMigration = `
-- Self-service account requests. Passwords are hashed at request time, so
-- approval never needs the plaintext. Approved rows become USER accounts
-- (or the chosen role, conferral-checked); rejected rows stay for audit.
CREATE TABLE IF NOT EXISTS registration_requests (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_registration_requests_status ON registration_requests(status);
`;
