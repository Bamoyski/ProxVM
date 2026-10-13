export const notificationsMigration = `
-- In-app notifications (delivery log, not audit): threats, tickets,
-- registration requests, new users, backup failures. Audience is either
-- 'admins' (visible to users.manage holders) or a single user id
-- (personal delivery, e.g. your backup failed). Read state per row;
-- listing is capped, oldest-first pruning happens on read.
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  audience TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NULL,
  link TEXT NULL,
  read_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_audience ON notifications(audience, created_at DESC);
`;
