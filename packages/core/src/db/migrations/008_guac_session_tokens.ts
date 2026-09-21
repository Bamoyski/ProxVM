export const guacSessionTokensMigration = `
-- Guacamole auth tokens minted by ProxVM launches, tracked per ProxVM
-- session so logout / password change / disable can revoke them server-side.
-- Tokens are AES-256-GCM encrypted like all other stored secrets.
CREATE TABLE IF NOT EXISTS guac_session_tokens (
  id UUID PRIMARY KEY,
  proxvm_session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_ciphertext TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guac_session_tokens_session ON guac_session_tokens(proxvm_session_id);
`;
