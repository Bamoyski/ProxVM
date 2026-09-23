import type { Pool } from "pg";
import type { Role } from "@proxvm/shared";
import { newId } from "../util/misc.js";
import { AppError } from "../util/errors.js";
import type { UsersService } from "./users.js";

export type RegistrationStatus = "pending" | "approved" | "rejected";

export interface RegistrationRequest {
  id: string;
  username: string;
  email: string | null;
  status: RegistrationStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

function toRequest(row: Record<string, unknown>): RegistrationRequest {
  return {
    id: String(row.id),
    username: String(row.username),
    email: (row.email as string | null) ?? null,
    status: row.status as RegistrationStatus,
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: row.decided_at ? new Date(row.decided_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

export class RegistrationService {
  constructor(
    private readonly db: Pool,
    private readonly users: UsersService,
  ) {}

  async request(input: { username: string; email?: string; passwordHash: string }): Promise<RegistrationRequest> {
    const taken =
      (await this.users.findByUsername(input.username)) ??
      (await this.db.query("SELECT id FROM registration_requests WHERE username = $1 AND status = 'pending'", [
        input.username,
      ])).rows[0];
    if (taken) throw AppError.conflict("Username already exists or has a pending request");
    const id = newId();
    await this.db.query(
      "INSERT INTO registration_requests (id, username, email, password_hash) VALUES ($1, $2, $3, $4)",
      [id, input.username, input.email ?? null, input.passwordHash],
    );
    const created = await this.get(id);
    if (!created) throw new Error("Registration request creation failed");
    return created;
  }

  async get(id: string): Promise<RegistrationRequest | null> {
    const result = await this.db.query("SELECT * FROM registration_requests WHERE id = $1", [id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? toRequest(row) : null;
  }

  async list(status?: RegistrationStatus): Promise<RegistrationRequest[]> {
    const result = status
      ? await this.db.query("SELECT * FROM registration_requests WHERE status = $1 ORDER BY created_at ASC", [status])
      : await this.db.query("SELECT * FROM registration_requests ORDER BY created_at ASC");
    return result.rows.map((r) => toRequest(r as Record<string, unknown>));
  }

  async pendingCount(): Promise<number> {
    const result = await this.db.query("SELECT COUNT(*)::int AS c FROM registration_requests WHERE status = 'pending'");
    return Number(result.rows[0]?.c ?? 0);
  }

  /**
   * Approve a pending request by creating the account with its stored hash.
   * The caller enforces role conferral; this only ever assigns existing roles.
   */
  async approve(id: string, actorId: string, roles: Role[]): Promise<{ userId: string }> {
    const row = (
      await this.db.query("SELECT * FROM registration_requests WHERE id = $1", [id])
    ).rows[0] as (Record<string, unknown> & { password_hash: string }) | undefined;
    if (!row) throw AppError.notFound("Registration request not found");
    if (row.status !== "pending") throw AppError.conflict(`Request is already ${row.status}`);
    if (await this.users.findByUsername(String(row.username))) {
      throw AppError.conflict("Username was taken while the request was pending");
    }
    const user = await this.users.create({
      username: String(row.username),
      email: (row.email as string | null) ?? undefined,
      passwordHash: String(row.password_hash),
      roles,
    });
    await this.db.query(
      "UPDATE registration_requests SET status = 'approved', decided_by = $2, decided_at = NOW() WHERE id = $1",
      [id, actorId],
    );
    return { userId: user.id };
  }

  async reject(id: string, actorId: string): Promise<void> {
    const result = await this.db.query(
      "UPDATE registration_requests SET status = 'rejected', decided_by = $2, decided_at = NOW() WHERE id = $1 AND status = 'pending'",
      [id, actorId],
    );
    if ((result.rowCount ?? 0) === 0) {
      const existing = await this.get(id);
      if (!existing) throw AppError.notFound("Registration request not found");
      throw AppError.conflict(`Request is already ${existing.status}`);
    }
  }
}
