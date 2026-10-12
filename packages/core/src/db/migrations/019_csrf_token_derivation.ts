export const csrfTokenDerivationMigration = `
-- Stop storing CSRF tokens. They are now derived on demand as
-- HMAC-SHA256(sessionSigningKey, session id) (see crypto/csrf.ts), so no
-- plaintext CSRF secret lives in the database. Session ids remain hashed at
-- rest (sid_hash); the raw session id is only ever held by the client cookie
-- and is never exposed by the API.
--
-- Existing plaintext tokens are discarded: dropping the column both removes
-- the stored secrets and guarantees no code path can read a stale value. No
-- session is invalidated by this migration (authentication uses sid_hash).
ALTER TABLE sessions DROP COLUMN csrf_token;
`;
