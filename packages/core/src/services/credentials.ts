// ---------------------------------------------------------------------------
// CredentialsService: encrypted per-VM guest password vault (one row/VM).
// - Plaintext never touches the DB: callers pass passwords in, encrypt()
//   runs here, and only ciphertext + key_id persist for key rotation.
// - view() is the only safe read shape; findByVm returns ciphertext and is
//   for rotation/Guacamole sync paths only, never for API responses.
// - tryClaimRotation is a compare-and-set on status so exactly one racer
//   leaves <> 'ROTATING'; losers must back off (409) or force-retry.
// - Status transitions (ENCRYPTED/ROTATING/VERIFIED/etc.) are advisory UI
//   state, not a security boundary; the ciphertext is the secret.
// ---------------------------------------------------------------------------
import type { Pool } from "pg";
import type { CredStatus } from "@proxvm/shared";
import { AppError } from "../util/errors.js";
import { newId } from "../util/misc.js";
import type { CredentialRow } from "./rows.js";

/** Safe API shape: metadata only, never ciphertext. */
export interface VmCredentialView {
  id: string;
  vmId: string;
  username: string;
  status: CredStatus;
  createdAt: Date;
  lastVerifiedAt: Date | null;
  lastRotatedAt: Date | null;
}

/** Encrypted per-VM vault; plaintext only in transit (see header). */
export class CredentialsService {
  constructor(
    private readonly db: Pool,
    private readonly encrypt: (plaintext: string) => string,
  ) {}

  // -- Writes: single row per VM; store() upserts, rotate() re-encrypts -
  async store(vmId: string, username: string, password: string, status: CredStatus = "ENCRYPTED"): Promise<string> {
    const existing = await this.findByVm(vmId);
    if (existing) {
      await this.updateRow(existing.id, username, password, status);
      return existing.id;
    }
    const id = newId();
    const ciphertext = this.encrypt(password);
    await this.db.query(
      `INSERT INTO vm_credentials (id, vm_id, username, password_ciphertext, key_id, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, vmId, username, ciphertext, keyIdOf(ciphertext), status],
    );
    return id;
  }

  async rotate(vmId: string, username: string, newPassword: string): Promise<void> {
    const row = await this.findByVm(vmId);
    if (!row) throw AppError.notFound("No credential stored for this VM");
    await this.updateRow(row.id, username, newPassword, "ROTATING");
    await this.db.query(
      "UPDATE vm_credentials SET last_rotated_at = NOW() WHERE id = $1",
      [row.id],
    );
  }

  async markRotatedSuccess(vmId: string): Promise<void> {
    await this.db.query(
      "UPDATE vm_credentials SET status = 'VERIFIED', last_verified_at = NOW() WHERE vm_id = $1",
      [vmId],
    );
  }

  private async updateRow(id: string, username: string, password: string, status: CredStatus): Promise<void> {
    const ciphertext = this.encrypt(password);
    await this.db.query(
      `UPDATE vm_credentials
       SET username = $2, password_ciphertext = $3, key_id = $4, status = $5,
           last_verified_at = CASE WHEN $5 = 'VERIFIED' THEN NOW() ELSE last_verified_at END
       WHERE id = $1`,
      [id, username, ciphertext, keyIdOf(ciphertext), status],
    );
  }

  async setStatus(vmId: string, status: CredStatus): Promise<void> {
    await this.db.query("UPDATE vm_credentials SET status = $2 WHERE vm_id = $1", [vmId, status]);
  }

  /**
   * Atomic rotation claim: exactly one concurrent rotation may proceed.
   * Returns true when this caller won the claim. Uses a compare-and-set on
   * status so two racing rotations cannot both read the same old password
   * and interleave guest updates (last-writer-wins with a stale password).
   */
  async tryClaimRotation(vmId: string): Promise<boolean> {
    const result = await this.db.query(
      "UPDATE vm_credentials SET status = 'ROTATING' WHERE vm_id = $1 AND status <> 'ROTATING'",
      [vmId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markVerified(vmId: string): Promise<void> {
    await this.db.query(
      "UPDATE vm_credentials SET status = 'VERIFIED', last_verified_at = NOW() WHERE vm_id = $1",
      [vmId],
    );
  }

  // -- Reads: ciphertext for rotation/sync only; view() is UI-safe -----
  async findByVm(vmId: string): Promise<CredentialRow | null> {
    const result = await this.db.query<CredentialRow>(
      "SELECT * FROM vm_credentials WHERE vm_id = $1",
      [vmId],
    );
    return result.rows[0] ?? null;
  }

  async delete(vmId: string): Promise<void> {
    await this.db.query("DELETE FROM vm_credentials WHERE vm_id = $1", [vmId]);
  }

  async view(vmId: string): Promise<VmCredentialView | null> {
    const row = await this.findByVm(vmId);
    if (!row) return null;
    return {
      id: row.id,
      vmId: row.vm_id,
      username: row.username,
      status: row.status,
      createdAt: row.created_at,
      lastVerifiedAt: row.last_verified_at,
      lastRotatedAt: row.last_rotated_at,
    };
  }
}

/** Splits "keyId:ciphertext"; legacy rows without a prefix read as v1. */
export function keyIdOf(ciphertext: string): string {
  const sep = ciphertext.indexOf(":");
  return sep > 0 ? ciphertext.slice(0, sep) : "v1";
}