import { createHash, randomBytes } from "node:crypto";
import { Pool as PgPool } from "pg";
import { createPgPool } from "../db/pool.js";
import mysql from "mysql2/promise";
import type { Pool as MySqlPool } from "mysql2/promise";
import type { Protocol } from "@proxvm/shared";

export type GuacamoleDbEngine = "postgresql" | "mariadb" | "mysql";

export class GuacamoleDbError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GuacamoleDbError";
    this.cause = cause;
  }
}

export interface GuacConnectionParams {
  protocol: Protocol;
  hostname: string;
  port: number;
  username: string;
  password: string;
}

export interface GuacamoleDbClient {
  testConnection(): Promise<{ ok: boolean; schemaVersion: string | null; detail: string | null }>;
  createUser(opts: { username: string; password: string }): Promise<number>;
  setUserPassword(username: string, password: string): Promise<void>;
  deleteUser(username: string): Promise<void>;
  createConnection(opts: { name: string; protocol: string; params: Record<string, string> }): Promise<number>;
  updateConnectionParams(connectionName: string, params: Record<string, string>): Promise<void>;
  getConnection(connectionName: string): Promise<{ connection_id: number; protocol: string } | null>;
  deleteConnection(connectionName: string): Promise<boolean>;
  grantConnectionRead(connectionName: string, guacUsername: string): Promise<void>;
  revokeConnectionAccess(connectionName: string, guacUsername: string): Promise<void>;
  grantRootGroupRead(guacUsername: string): Promise<void>;
  revokeRootGroupRead(guacUsername: string): Promise<void>;
}

export function sha256SaltedHashPassword(password: string): { hash: Buffer; salt: Buffer } {
  const salt = randomBytes(32);
  // Matches Guacamole's SHA256PasswordEncryptionService (guacamole-auth-jdbc):
  // the salt is appended AFTER the password as an UPPERCASE hex string, and the
  // combined text is hashed as UTF-8 bytes: SHA256(password + hex(salt).toUpperCase()).
  const salted = password + salt.toString("hex").toUpperCase();
  const digest = createHash("sha256").update(salted, "utf8").digest();
  return { hash: digest, salt };
}

export function encodeParameter(value: string): string {
  // Guacamole's JDBC auth stores connection parameters as plaintext; guacd
  // receives the raw DB values. No encoding must be applied here.
  return value;
}

export function connectionParamsFor(opts: GuacConnectionParams): Record<string, string> {
  if (opts.protocol === "ssh") {
    return {
      hostname: opts.hostname,
      port: String(opts.port),
      username: opts.username,
      password: opts.password,
      "color-scheme": "gray-black",
      "font-name": "monospace",
      "font-size": "12",
    };
  }
  if (opts.protocol === "rdp") {
    return {
      hostname: opts.hostname,
      port: String(opts.port),
      username: opts.username,
      password: opts.password,
      security: "any",
      "ignore-cert": "true",
      "disable-auth": "false",
    };
  }
  return {
    hostname: opts.hostname,
    port: String(opts.port),
    username: opts.username,
    password: opts.password,
  };
}

export class GuacamolePostgresClient implements GuacamoleDbClient {
  constructor(private readonly pool: PgPool) {}

  async testConnection(): Promise<{ ok: boolean; schemaVersion: string | null; detail: string | null }> {
    try {
      const result = await this.pool.query<{ c: string }>("SELECT 1 AS c");
      if (Number(result.rows[0]?.c) !== 1) {
        return { ok: false, schemaVersion: null, detail: "SELECT 1 did not return an expected result" };
      }
    } catch (err) {
      return { ok: false, schemaVersion: null, detail: err instanceof Error ? err.message : "connection failed" };
    }
    try {
      const table = await this.pool.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'guacamole_connection') AS present",
      );
      if (!table.rows[0]?.present) {
        return {
          ok: false,
          schemaVersion: null,
          detail:
            "Guacamole database schema not found (no guacamole_connection table). Initialize the database with the Guacamole schema first.",
        };
      }
    } catch (err) {
      return { ok: false, schemaVersion: null, detail: err instanceof Error ? err.message : "failed to inspect schema" };
    }
    return this.checkSchemaVersion((sql) => this.pool.query<{ version: string }>(sql).then((r) => r.rows));
  }

  private async checkSchemaVersion(run: (sql: string) => Promise<Array<{ version: string }>>): Promise<{ ok: boolean; schemaVersion: string | null; detail: null }> {
    let schemaVersion: string | null = null;
    try {
      const rows = await run("SELECT version FROM guacamole_database_scm_properties LIMIT 1");
      schemaVersion = rows[0]?.version ?? null;
    } catch {
      schemaVersion = null;
    }
    return { ok: true, schemaVersion, detail: null };
  }

  async createUser(opts: { username: string; password: string }): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ entity_id: number; user_id: number }>(
        `SELECT gue.entity_id, guu.user_id
         FROM guacamole_entity gue
         LEFT JOIN guacamole_user guu ON guu.entity_id = gue.entity_id
         WHERE gue.name = $1 AND gue.type = 'USER'`,
        [opts.username],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return Number(existing.rows[0].user_id);
      }
      const entity = await client.query<{ entity_id: number }>(
        "INSERT INTO guacamole_entity (name, type) VALUES ($1, 'USER') RETURNING entity_id",
        [opts.username],
      );
      const entityId = Number(entity.rows[0]?.entity_id);
      const { hash, salt } = sha256SaltedHashPassword(opts.password);
      const user = await client.query<{ user_id: number }>(
        `INSERT INTO guacamole_user (entity_id, password_hash, password_salt, password_date, disabled, expired)
         VALUES ($1, $2, $3, NOW()::date, FALSE, FALSE) RETURNING user_id`,
        [entityId, hash, salt],
      );
      await client.query("COMMIT");
      return Number(user.rows[0]?.user_id);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new GuacamoleDbError(
        `Failed to create Guacamole user: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      client.release();
    }
  }

  async setUserPassword(username: string, password: string): Promise<void> {
    const { hash, salt } = sha256SaltedHashPassword(password);
    await this.pool.query(
      `UPDATE guacamole_user
       SET password_hash = $2, password_salt = $3, password_date = NOW()::date
       WHERE entity_id = (SELECT entity_id FROM guacamole_entity WHERE name = $1 AND type = 'USER')`,
      [username, hash, salt],
    );
  }

  async deleteUser(username: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM guacamole_user_permission WHERE entity_id =
          (SELECT entity_id FROM guacamole_entity WHERE name = $1 AND type = 'USER')`,
        [username],
      );
      await client.query(
        `DELETE FROM guacamole_connection_permission WHERE entity_id =
          (SELECT entity_id FROM guacamole_entity WHERE name = $1 AND type = 'USER')`,
        [username],
      );
      await client.query(
        `DELETE FROM guacamole_connection_group_permission WHERE entity_id =
          (SELECT entity_id FROM guacamole_entity WHERE name = $1 AND type = 'USER')`,
        [username],
      );
      await client.query(
        `DELETE FROM guacamole_user WHERE entity_id =
          (SELECT entity_id FROM guacamole_entity WHERE name = $1 AND type = 'USER')`,
        [username],
      );
      await client.query("DELETE FROM guacamole_entity WHERE name = $1 AND type = 'USER'", [username]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new GuacamoleDbError(
        `Failed to delete Guacamole user: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      client.release();
    }
  }

  async createConnection(opts: { name: string; protocol: string; params: Record<string, string> }): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ connection_id: number }>(
        "SELECT connection_id FROM guacamole_connection WHERE connection_name = $1",
        [opts.name],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return Number(existing.rows[0].connection_id);
      }
      const conn = await client.query<{ connection_id: number }>(
        `INSERT INTO guacamole_connection (connection_name, parent_id, protocol)
         VALUES ($1, NULL, $2) RETURNING connection_id`,
        [opts.name, opts.protocol],
      );
      const connectionId = Number(conn.rows[0]?.connection_id);
      for (const [key, value] of Object.entries(opts.params)) {
        await client.query(
          `INSERT INTO guacamole_connection_parameter (connection_id, parameter_name, parameter_value)
           VALUES ($1, $2, $3)`,
          [connectionId, key, encodeParameter(value)],
        );
      }
      await client.query("COMMIT");
      return connectionId;
    } catch (err) {
      await client.query("ROLLBACK");
      throw new GuacamoleDbError(
        `Failed to create Guacamole connection: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      client.release();
    }
  }

  async updateConnectionParams(connectionName: string, params: Record<string, string>): Promise<void> {
    const conn = await this.pool.query<{ connection_id: number }>(
      "SELECT connection_id FROM guacamole_connection WHERE connection_name = $1",
      [connectionName],
    );
    const connectionId = conn.rows[0]?.connection_id;
    if (!connectionId) {
      throw new GuacamoleDbError(`Guacamole connection ${connectionName} not found`);
    }
    for (const [key, value] of Object.entries(params)) {
      await this.pool.query(
        `INSERT INTO guacamole_connection_parameter (connection_id, parameter_name, parameter_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (connection_id, parameter_name)
         DO UPDATE SET parameter_value = EXCLUDED.parameter_value`,
        [connectionId, key, encodeParameter(value)],
      );
    }
  }

  async getConnection(connectionName: string): Promise<{ connection_id: number; protocol: string } | null> {
    const result = await this.pool.query<{ connection_id: number; protocol: string }>(
      "SELECT connection_id, protocol FROM guacamole_connection WHERE connection_name = $1",
      [connectionName],
    );
    return result.rows[0] ?? null;
  }

  async deleteConnection(connectionName: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM guacamole_connection WHERE connection_name = $1",
      [connectionName],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async grantConnectionRead(connectionName: string, guacUsername: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO guacamole_connection_permission (connection_id, entity_id, permission)
       VALUES (
         (SELECT connection_id FROM guacamole_connection WHERE connection_name = $1),
         (SELECT entity_id FROM guacamole_entity WHERE name = $2 AND type = 'USER'),
         'READ'
       )
       ON CONFLICT DO NOTHING`,
      [connectionName, guacUsername],
    );
  }

  async revokeConnectionAccess(connectionName: string, guacUsername: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM guacamole_connection_permission
       WHERE connection_id = (SELECT connection_id FROM guacamole_connection WHERE connection_name = $1)
         AND entity_id = (SELECT entity_id FROM guacamole_entity WHERE name = $2 AND type = 'USER')`,
      [connectionName, guacUsername],
    );
  }

  async grantRootGroupRead(guacUsername: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO guacamole_connection_group_permission (connection_group_id, entity_id, permission)
       VALUES (
         (SELECT connection_group_id FROM guacamole_connection_group
           WHERE parent_id IS NULL
           ORDER BY connection_group_id LIMIT 1),
         (SELECT entity_id FROM guacamole_entity WHERE name = $1 AND type = 'USER'),
         'READ'
       )
       ON CONFLICT DO NOTHING`,
      [guacUsername],
    );
  }

  async revokeRootGroupRead(guacUsername: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM guacamole_connection_group_permission
       WHERE entity_id = (SELECT entity_id FROM guacamole_entity WHERE name = $1 AND type = 'USER')`,
      [guacUsername],
    );
  }
}

export class GuacamoleMySqlClient implements GuacamoleDbClient {
  constructor(private readonly pool: MySqlPool) {}

  private async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const [rows] = await this.pool.query(sql, params as never);
    return rows as T[];
  }

  private async execute(sql: string, params: unknown[] = []): Promise<{ insertId: number; affectedRows: number }> {
    const [result] = await this.pool.execute(sql, params as never);
    const r = result as { insertId?: number; affectedRows?: number };
    return { insertId: Number(r.insertId ?? 0), affectedRows: Number(r.affectedRows ?? 0) };
  }

  async testConnection(): Promise<{ ok: boolean; schemaVersion: string | null; detail: string | null }> {
    try {
      const rows = await this.query<{ c: number }>("SELECT 1 AS c");
      if (Number(rows[0]?.c) !== 1) {
        return { ok: false, schemaVersion: null, detail: "SELECT 1 did not return an expected result" };
      }
    } catch (err) {
      return { ok: false, schemaVersion: null, detail: err instanceof Error ? err.message : "connection failed" };
    }
    try {
      const table = await this.query<{ present: number }>(
        "SELECT COUNT(*) AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'guacamole_connection'",
      );
      if (Number(table[0]?.present ?? 0) === 0) {
        return {
          ok: false,
          schemaVersion: null,
          detail:
            "Guacamole database schema not found (no guacamole_connection table). Initialize the database with the Guacamole schema first.",
        };
      }
    } catch (err) {
      return { ok: false, schemaVersion: null, detail: err instanceof Error ? err.message : "failed to inspect schema" };
    }
    let schemaVersion: string | null = null;
    try {
      const version = await this.query<{ version: string }>(
        "SELECT version FROM guacamole_database_scm_properties LIMIT 1",
      );
      schemaVersion = version[0]?.version ?? null;
    } catch {
      schemaVersion = null;
    }
    return { ok: true, schemaVersion, detail: null };
  }

  async createUser(opts: { username: string; password: string }): Promise<number> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const existing = await conn.query(
        `SELECT gue.entity_id AS entity_id, guu.user_id AS user_id
         FROM guacamole_entity gue
         LEFT JOIN guacamole_user guu ON guu.entity_id = gue.entity_id
         WHERE gue.name = ? AND gue.type = 'USER'`,
        [opts.username],
      );
      const existingRows = existing[0] as Array<{ entity_id: number; user_id: number | null }>;
      if (existingRows[0]) {
        await conn.commit();
        if (existingRows[0].user_id !== null && existingRows[0].user_id !== undefined) {
          return Number(existingRows[0].user_id);
        }
        conn.release();
        return this.setUserPassword(opts.username, opts.password).then(() => this.getUserId(opts.username));
      }
      const entity = await conn.query(
        "INSERT INTO guacamole_entity (name, type) VALUES (?, 'USER')",
        [opts.username],
      );
      const entityId = Number((entity[0] as { insertId: number }).insertId);
      const { hash, salt } = sha256SaltedHashPassword(opts.password);
      await conn.query(
        `INSERT INTO guacamole_user (entity_id, password_hash, password_salt, password_date, disabled, expired)
         VALUES (?, ?, ?, CURRENT_DATE(), 0, 0)`,
        [entityId, hash, salt],
      );
      await conn.commit();
      return this.getUserIdFrom(conn, opts.username);
    } catch (err) {
      await conn.rollback();
      throw new GuacamoleDbError(
        `Failed to create Guacamole user: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      conn.release();
    }
  }

  private async getUserId(username: string): Promise<number> {
    const rows = await this.query<{ user_id: number }>(
      `SELECT guu.user_id AS user_id FROM guacamole_user guu
       JOIN guacamole_entity gue ON guu.entity_id = gue.entity_id
       WHERE gue.name = ? AND gue.type = 'USER'`,
      [username],
    );
    return Number(rows[0]?.user_id ?? 0);
  }

  private async getUserIdFrom(
    conn: { query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]> },
    username: string,
  ): Promise<number> {
    const result = await conn.query(
      `SELECT guu.user_id AS user_id FROM guacamole_user guu
       JOIN guacamole_entity gue ON guu.entity_id = gue.entity_id
       WHERE gue.name = ? AND gue.type = 'USER'`,
      [username],
    );
    const rows = result[0] as Array<{ user_id: number }>;
    return Number(rows[0]?.user_id ?? 0);
  }

  async setUserPassword(username: string, password: string): Promise<void> {
    const { hash, salt } = sha256SaltedHashPassword(password);
    await this.execute(
      `UPDATE guacamole_user
       SET password_hash = ?, password_salt = ?, password_date = CURRENT_DATE()
       WHERE entity_id = (SELECT entity_id FROM guacamole_entity WHERE name = ? AND type = 'USER')`,
      [hash, salt, username],
    );
  }

  async deleteUser(username: string): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `DELETE FROM guacamole_user_permission WHERE entity_id =
          (SELECT entity_id FROM guacamole_entity WHERE name = ? AND type = 'USER')`,
        [username],
      );
      await conn.query(
        `DELETE FROM guacamole_connection_permission WHERE entity_id =
          (SELECT entity_id FROM guacamole_entity WHERE name = ? AND type = 'USER')`,
        [username],
      );
      await conn.query(
        `DELETE FROM guacamole_connection_group_permission WHERE entity_id =
          (SELECT entity_id FROM guacamole_entity WHERE name = ? AND type = 'USER')`,
        [username],
      );
      await conn.query(
        `DELETE FROM guacamole_user WHERE entity_id =
          (SELECT entity_id FROM guacamole_entity WHERE name = ? AND type = 'USER')`,
        [username],
      );
      await conn.query("DELETE FROM guacamole_entity WHERE name = ? AND type = 'USER'", [username]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw new GuacamoleDbError(
        `Failed to delete Guacamole user: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      conn.release();
    }
  }

  async createConnection(opts: { name: string; protocol: string; params: Record<string, string> }): Promise<number> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const existing = await conn.query(
        "SELECT connection_id FROM guacamole_connection WHERE connection_name = ?",
        [opts.name],
      );
      const existingRows = existing[0] as Array<{ connection_id: number }>;
      if (existingRows[0]) {
        await conn.commit();
        conn.release();
        await this.updateConnectionParams(opts.name, opts.params);
        return Number(existingRows[0].connection_id);
      }
      const result = await conn.query(
        "INSERT INTO guacamole_connection (connection_name, parent_id, protocol) VALUES (?, NULL, ?)",
        [opts.name, opts.protocol],
      );
      const connectionId = Number((result[0] as { insertId: number }).insertId);
      for (const [key, value] of Object.entries(opts.params)) {
        await conn.query(
          `INSERT INTO guacamole_connection_parameter (connection_id, parameter_name, parameter_value)
           VALUES (?, ?, ?)`,
          [connectionId, key, encodeParameter(value)],
        );
      }
      await conn.commit();
      return connectionId;
    } catch (err) {
      await conn.rollback();
      throw new GuacamoleDbError(
        `Failed to create Guacamole connection: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      conn.release();
    }
  }

  async updateConnectionParams(connectionName: string, params: Record<string, string>): Promise<void> {
    const rows = await this.query<{ connection_id: number }>(
      "SELECT connection_id FROM guacamole_connection WHERE connection_name = ?",
      [connectionName],
    );
    const connectionId = Number(rows[0]?.connection_id ?? 0);
    if (!connectionId) {
      throw new GuacamoleDbError(`Guacamole connection ${connectionName} not found`);
    }
    for (const [key, value] of Object.entries(params)) {
      await this.execute(
        `INSERT INTO guacamole_connection_parameter (connection_id, parameter_name, parameter_value)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE parameter_value = VALUES(parameter_value)`,
        [connectionId, key, encodeParameter(value)],
      );
    }
  }

  async getConnection(connectionName: string): Promise<{ connection_id: number; protocol: string } | null> {
    const rows = await this.query<{ connection_id: number; protocol: string }>(
      "SELECT connection_id, protocol FROM guacamole_connection WHERE connection_name = ?",
      [connectionName],
    );
    return rows[0] ?? null;
  }

  async deleteConnection(connectionName: string): Promise<boolean> {
    const result = await this.execute(
      "DELETE FROM guacamole_connection WHERE connection_name = ?",
      [connectionName],
    );
    return result.affectedRows > 0;
  }

  async grantConnectionRead(connectionName: string, guacUsername: string): Promise<void> {
    await this.execute(
      `INSERT IGNORE INTO guacamole_connection_permission (connection_id, entity_id, permission)
       VALUES (
         (SELECT connection_id FROM guacamole_connection WHERE connection_name = ?),
         (SELECT entity_id FROM guacamole_entity WHERE name = ? AND type = 'USER'),
         'READ'
       )`,
      [connectionName, guacUsername],
    );
  }

  async revokeConnectionAccess(connectionName: string, guacUsername: string): Promise<void> {
    await this.execute(
      `DELETE FROM guacamole_connection_permission
       WHERE connection_id = (SELECT connection_id FROM guacamole_connection WHERE connection_name = ?)
         AND entity_id = (SELECT entity_id FROM guacamole_entity WHERE name = ? AND type = 'USER')`,
      [connectionName, guacUsername],
    );
  }

  async grantRootGroupRead(guacUsername: string): Promise<void> {
    await this.execute(
      `INSERT IGNORE INTO guacamole_connection_group_permission (connection_group_id, entity_id, permission)
       VALUES (
         (SELECT connection_group_id FROM guacamole_connection_group
           WHERE parent_id IS NULL
           ORDER BY connection_group_id LIMIT 1),
         (SELECT entity_id FROM guacamole_entity WHERE name = ? AND type = 'USER'),
         'READ'
       )`,
      [guacUsername],
    );
  }

  async revokeRootGroupRead(guacUsername: string): Promise<void> {
    await this.execute(
      `DELETE FROM guacamole_connection_group_permission
       WHERE entity_id = (SELECT entity_id FROM guacamole_entity WHERE name = ? AND type = 'USER')`,
      [guacUsername],
    );
  }
}

export interface GuacamoleDbSettings {
  engine: GuacamoleDbEngine;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbSsl: boolean;
}

export function createGuacamoleDbClient(settings: GuacamoleDbSettings): { client: GuacamoleDbClient; close: () => Promise<void> } {
  const engine = settings.engine === "mariadb" || settings.engine === "mysql" ? "mysql" : "postgresql";
  if (engine === "mysql") {
    const pool = mysql.createPool({
      host: settings.dbHost,
      port: settings.dbPort,
      user: settings.dbUser,
      password: settings.dbPassword,
      database: settings.dbName,
      ssl: settings.dbSsl ? { rejectUnauthorized: false } : undefined,
      connectionLimit: 5,
      connectTimeout: 8000,
      decimalNumbers: true,
    });
    return { client: new GuacamoleMySqlClient(pool), close: () => pool.end() };
  }
  const pool = createPgPool({
    host: settings.dbHost,
    port: settings.dbPort,
    user: settings.dbUser,
    password: settings.dbPassword,
    database: settings.dbName,
    ssl: settings.dbSsl,
    connectionTimeoutMillis: 8000,
  });
  return { client: new GuacamolePostgresClient(pool), close: () => pool.end() };
}