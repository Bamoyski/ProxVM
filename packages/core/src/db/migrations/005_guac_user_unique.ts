export const guacUserUniqueMigration = `
CREATE UNIQUE INDEX IF NOT EXISTS guacamole_users_user_id_key ON guacamole_users (user_id);
`;
