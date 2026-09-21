import type { Pool } from "pg";
import type { Protocol } from "@proxvm/shared";
import { AppError } from "../util/errors.js";
import { newId } from "../util/misc.js";
import { generatePassword } from "../crypto/password.js";
import { keyIdOf } from "./credentials.js";
import {
  GuacamoleDbClient,
  connectionParamsFor,
  type GuacConnectionParams,
} from "../guacamole/db.js";
import {
  GuacamoleApiClient,
  buildClientLaunchUrl,
  buildLoginUrl,
} from "../guacamole/api.js";
import { testConnection, type ConnectionTestResult } from "../guacamole/test-connection.js";
import type { GuacConnectionRow, GuacUserRow } from "./rows.js";

export interface GuacamoleServiceDeps {
  db: Pool;
  encrypt: (plaintext: string) => string;
  decrypt: (stored: string) => string;
}

export class GuacamoleService {
  constructor(private readonly deps: GuacamoleServiceDeps) {}

  private get db(): Pool {
    return this.deps.db;
  }

  async findConnectionRecord(vmId: string, protocol?: Protocol): Promise<GuacConnectionRow | null> {
    if (protocol) {
      const result = await this.db.query<GuacConnectionRow>(
        "SELECT * FROM guacamole_connections WHERE vm_id = $1 AND protocol = $2",
        [vmId, protocol],
      );
      return result.rows[0] ?? null;
    }
    const result = await this.db.query<GuacConnectionRow>(
      "SELECT * FROM guacamole_connections WHERE vm_id = $1 ORDER BY created_at ASC",
      [vmId],
    );
    return result.rows[0] ?? null;
  }

  async listConnectionRecords(vmId: string): Promise<GuacConnectionRow[]> {
    const result = await this.db.query<GuacConnectionRow>(
      "SELECT * FROM guacamole_connections WHERE vm_id = $1 ORDER BY created_at ASC",
      [vmId],
    );
    return result.rows;
  }

  async upsertConnection(opts: {
    vmId: string;
    vmName: string;
    protocol: Protocol;
    hostname: string;
    port: number;
    username: string;
    password: string;
    guacDb: GuacamoleDbClient;
    connectionName?: string;
  }): Promise<{ record: GuacConnectionRow; guacConnectionId: number }> {
    const params = connectionParamsFor({
      protocol: opts.protocol,
      hostname: opts.hostname,
      port: opts.port,
      username: opts.username,
      password: opts.password,
    });
    const connectionName = opts.connectionName ?? `proxvm-${opts.vmName}`;
    const guacConnectionId = await opts.guacDb.createConnection({
      name: connectionName,
      protocol: opts.protocol,
      params,
    });
    const existing = await this.findConnectionRecord(opts.vmId, opts.protocol);
    const ciphertext = this.deps.encrypt(opts.password);
    if (existing) {
      const result = await this.db.query<GuacConnectionRow>(
        `UPDATE guacamole_connections SET
           protocol = $2, hostname = $3, port = $4, username = $5,
           password_ciphertext = $6, key_id = $7, guac_connection_name = $8,
           guac_identifier = $9, status = 'ACTIVE', updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [
          existing.id,
          opts.protocol,
          opts.hostname,
          opts.port,
          opts.username,
          ciphertext,
          keyIdOf(ciphertext),
          connectionName,
          String(guacConnectionId),
        ],
      );
      return { record: result.rows[0] as GuacConnectionRow, guacConnectionId };
    }
    const result = await this.db.query<GuacConnectionRow>(
      `INSERT INTO guacamole_connections (id, vm_id, protocol, hostname, port, username,
        password_ciphertext, key_id, guac_connection_name, guac_identifier, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE')
       RETURNING *`,
      [
        newId(),
        opts.vmId,
        opts.protocol,
        opts.hostname,
        opts.port,
        opts.username,
        ciphertext,
        keyIdOf(ciphertext),
        connectionName,
        String(guacConnectionId),
      ],
    );
    return { record: result.rows[0] as GuacConnectionRow, guacConnectionId };
  }

  async updateConnectionPassword(
    vmId: string,
    password: string,
    guacDb: GuacamoleDbClient,
  ): Promise<void> {
    const records = await this.listConnectionRecords(vmId);
    for (const record of records) {
      const ciphertext = this.deps.encrypt(password);
      await this.db.query(
        `UPDATE guacamole_connections SET password_ciphertext = $2, key_id = $3, updated_at = NOW()
         WHERE id = $1`,
        [record.id, ciphertext, keyIdOf(ciphertext)],
      );
      try {
        await guacDb.updateConnectionParams(record.guac_connection_name, { password });
      } catch (err) {
        throw AppError.external(
          "Guacamole",
          `Failed to update Guacamole connection parameters: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
    }
  }

  async updateConnectionEndpoint(vmId: string, hostname: string, port: number, guacDb: GuacamoleDbClient): Promise<void> {
    const records = await this.listConnectionRecords(vmId);
    for (const record of records) {
      await this.db.query(
        "UPDATE guacamole_connections SET hostname = $2, port = $3, updated_at = NOW() WHERE id = $1",
        [record.id, hostname, port],
      );
      await guacDb.updateConnectionParams(record.guac_connection_name, {
        hostname,
        port: String(port),
      });
    }
  }

  async findUserRecord(userId: string): Promise<GuacUserRow | null> {
    const result = await this.db.query<GuacUserRow>(
      "SELECT * FROM guacamole_users WHERE user_id = $1",
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async ensureGuacUser(
    userId: string,
    appUsername: string,
    guacDb: GuacamoleDbClient,
  ): Promise<GuacUserRow> {
    const existing = await this.findUserRecord(userId);
    const guacUsername = `px_${appUsername.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 40)}`;
    const password = existing ? this.deps.decrypt(existing.password_ciphertext) : generatePassword(24);
    await guacDb.createUser({ username: guacUsername, password });
    await guacDb.setUserPassword(guacUsername, password);
    await guacDb.grantRootGroupRead(guacUsername);
    const ciphertext = this.deps.encrypt(password);
    const result = await this.db.query<GuacUserRow>(
      `INSERT INTO guacamole_users (id, user_id, guac_username, password_ciphertext, key_id, status)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
       ON CONFLICT (user_id) DO UPDATE SET
         guac_username = EXCLUDED.guac_username,
         password_ciphertext = EXCLUDED.password_ciphertext,
         key_id = EXCLUDED.key_id,
         status = 'ACTIVE',
         updated_at = NOW()
       RETURNING *`,
      [newId(), userId, guacUsername, ciphertext, keyIdOf(ciphertext)],
    );
    return result.rows[0] as GuacUserRow;
  }

  async grantVmAccess(vmId: string, appUserId: string, guacDb: GuacamoleDbClient): Promise<void> {
    const connections = await this.listConnectionRecords(vmId);
    const userRecord = await this.findUserRecord(appUserId);
    if (!userRecord) return;
    for (const connection of connections) {
      await guacDb.grantConnectionRead(connection.guac_connection_name, userRecord.guac_username);
    }
  }

  async revokeVmAccess(vmId: string, appUserId: string, guacDb: GuacamoleDbClient): Promise<void> {
    const connections = await this.listConnectionRecords(vmId);
    const userRecord = await this.findUserRecord(appUserId);
    if (!userRecord) return;
    for (const connection of connections) {
      await guacDb.revokeConnectionAccess(connection.guac_connection_name, userRecord.guac_username);
    }
  }

  async deleteVmResources(vmId: string, guacDb: GuacamoleDbClient): Promise<void> {
    const connections = await this.listConnectionRecords(vmId);
    for (const connection of connections) {
      try {
        await guacDb.deleteConnection(connection.guac_connection_name);
      } catch (err) {
        throw AppError.external(
          "Guacamole",
          `Failed to delete Guacamole connection: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      await this.db.query("DELETE FROM guacamole_connections WHERE id = $1", [connection.id]);
    }
  }

  async verifyConnection(record: GuacConnectionRow, guacDb: GuacamoleDbClient): Promise<{ ok: boolean; detail: string }> {
    try {
      const row = await guacDb.getConnection(record.guac_connection_name);
      if (!row) {
        return { ok: false, detail: "Connection row is missing from the Guacamole database" };
      }
      return { ok: true, detail: `connection_id=${row.connection_id}, protocol=${row.protocol}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async launch(
    vmId: string,
    appUserId: string,
    guacApi: GuacamoleApiClient | null,
    guacUrl: string,
    publicUrl?: string | null,
    protocol?: Protocol,
    opts?: { trackSessionId?: string },
  ): Promise<{ url: string; mode: "direct" | "login"; detail?: string }> {
    const connection = await this.findConnectionRecord(vmId, protocol);
    if (!connection) throw AppError.notFound("No Guacamole connection exists for this VM");
    const userRecord = await this.findUserRecord(appUserId);
    if (!userRecord) {
      throw AppError.validation("You do not have a Guacamole account yet");
    }
    const password = this.deps.decrypt(userRecord.password_ciphertext);
    if (guacApi) {
      try {
        const token = await guacApi.requestToken(userRecord.guac_username, password);
        let identifier = connection.guac_identifier;
        if (token.dataSource) {
          const discovered = await guacApi
            .findConnectionIdentifier(token.authToken, token.dataSource, connection.guac_connection_name)
            .catch(() => null);
          if (discovered) identifier = discovered;
        }
        if (!identifier) {
          return { url: buildLoginUrl(publicUrl || guacUrl), mode: "login", detail: `Guacamole connection "${connection.guac_connection_name}" could not be found in the Guacamole data source.` };
        }
        if (opts?.trackSessionId) {
          await this.trackSessionToken(opts.trackSessionId, token.authToken).catch(() => undefined);
        }
        return { url: buildClientLaunchUrl(publicUrl || guacUrl, identifier, token.authToken), mode: "direct" };
      } catch (err) {
        return { url: buildLoginUrl(publicUrl || guacUrl), mode: "login", detail: err instanceof Error ? err.message : String(err) };
      }
    }
    return { url: buildLoginUrl(publicUrl || guacUrl), mode: "login", detail: "Guacamole API client is not available." };
  }

  /**
   * Diagnose one stored connection without revealing secrets: TCP reachability
   * always, plus an SSH authentication check against the stored credential
   * (SSH only) or an RDP handshake liveness check (RDP only). Read-only from
   * the guest's perspective apart from a single login attempt.
   */
  async testConnectionRecord(
    vmId: string,
    protocol?: Protocol,
  ): Promise<ConnectionTestResult & { protocol: string; hostname: string; port: number }> {
    const connection = await this.findConnectionRecord(vmId, protocol);
    if (!connection) throw AppError.notFound("No Guacamole connection exists for this VM");
    const password = this.deps.decrypt(connection.password_ciphertext);
    return {
      protocol: connection.protocol,
      hostname: connection.hostname,
      port: connection.port,
      ...(await testConnection({
        protocol: connection.protocol,
        hostname: connection.hostname,
        port: connection.port,
        username: connection.username,
        password,
      })),
    };
  }

  /**
   * Remember a Guacamole auth token against a ProxVM session so logout and
   * revocation paths can invalidate it server-side. Tokens are encrypted at
   * rest; tracking failures never break launches.
   */
  async trackSessionToken(proxvmSessionId: string, token: string): Promise<void> {
    const ciphertext = this.deps.encrypt(token);
    await this.db.query(
      "INSERT INTO guac_session_tokens (id, proxvm_session_id, token_ciphertext, key_id) VALUES ($1, $2, $3, $4)",
      [newId(), proxvmSessionId, ciphertext, keyIdOf(ciphertext)],
    );
  }

  /**
   * Invalidate every Guacamole token tracked for a ProxVM session (or for all
   * sessions of a user) and drop the rows. Remote failures are best-effort:
   * Guacamole's own api-session-timeout bounds any token we cannot reach.
   * Returns the number of tracked tokens revoked.
   */
  async revokeSessionTokens(proxvmSessionId: string, guacApi: GuacamoleApiClient | null): Promise<number> {
    const rows = await this.db.query<{ token_ciphertext: string }>(
      "SELECT token_ciphertext FROM guac_session_tokens WHERE proxvm_session_id = $1",
      [proxvmSessionId],
    );
    let revoked = 0;
    for (const row of rows.rows) {
      try {
        if (guacApi) {
          await guacApi.deleteToken(this.deps.decrypt(row.token_ciphertext));
          revoked += 1;
        }
      } catch {
        // best-effort; row is still deleted below
      }
    }
    await this.db.query("DELETE FROM guac_session_tokens WHERE proxvm_session_id = $1", [proxvmSessionId]);
    return revoked;
  }

  async revokeAllUserTokens(userId: string, guacApi: GuacamoleApiClient | null): Promise<number> {
    const sessions = await this.db.query<{ id: string }>(
      "SELECT id FROM sessions WHERE user_id = $1",
      [userId],
    );
    let total = 0;
    for (const s of sessions.rows) {
      total += await this.revokeSessionTokens(s.id, guacApi);
    }
    return total;
  }

  async removeUserResources(appUserId: string, guacDb: GuacamoleDbClient): Promise<void> {
    const userRecord = await this.findUserRecord(appUserId);
    if (!userRecord) return;
    await guacDb.deleteUser(userRecord.guac_username);
    await this.db.query("DELETE FROM guacamole_users WHERE user_id = $1", [appUserId]);
  }

  /**
   * Suspend or restore the user's Guacamole account without deleting it, so
   * disabling a ProxVM account also stops direct Guacamole logins (which
   * ProxVM sessions/revocation otherwise do not reach). No-op when the user
   * has no Guacamole account.
   */
  async setGuacUserDisabled(appUserId: string, disabled: boolean, guacDb: GuacamoleDbClient): Promise<void> {
    const userRecord = await this.findUserRecord(appUserId);
    if (!userRecord) return;
    await guacDb.setUserDisabled(userRecord.guac_username, disabled);
  }
}