import type { Pool, PoolClient } from "pg";
import type { Queryable } from "../db/pool.js";
import type { PublicUser, Role, UserWithRoles } from "@proxvm/shared";
import { AppError } from "../util/errors.js";
import { isUuid, newId, toIso } from "../util/misc.js";
import { ROLE_IDS, validRoles } from "./rbac.js";
import { settingsSeeds } from "../db/migrations/001_initial.js";
import type { UserRoleRow } from "./rows.js";

export interface CreateUserInput {
  username: string;
  email?: string;
  givenName?: string;
  passwordHash: string;
  roles: Role[];
}

export class UsersService {
  constructor(private readonly db: Pool) {}

  async ensureSeeded(): Promise<void> {
    const result = await this.db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM roles");
    if (result.rows[0]?.count === "0") {
      await this.db.query(settingsSeeds);
    }
  }

  async countUsers(): Promise<number> {
    const result = await this.db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
    return Number(result.rows[0]?.count ?? "0");
  }

  async create(input: CreateUserInput, internals?: PoolClient): Promise<UserWithRoles> {
    const q = internals ?? this.db;
    const id = newId();
    await q.query(
      `INSERT INTO users (id, username, email, given_name, password_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, input.username, input.email ?? null, input.givenName ?? null, input.passwordHash],
    );
    await this.setRoles(id, input.roles, q);
    return this.requireById(id, q);
  }

  async setRoles(userId: string, roles: Role[], q: Queryable = this.db): Promise<void> {
    await q.query("DELETE FROM user_roles WHERE user_id = $1", [userId]);
    for (const role of validRoles(roles)) {
      await q.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [
        userId,
        ROLE_IDS[role],
      ]);
    }
  }

  async markInitialAdmin(userId: string): Promise<void> {
    await this.db.query("UPDATE users SET is_initial_admin = true WHERE id = $1", [userId]);
  }

  async isInitialAdmin(userId: string): Promise<boolean> {
    const result = await this.db.query<{ is_initial_admin: boolean }>(
      "SELECT is_initial_admin FROM users WHERE id = $1",
      [userId],
    );
    return result.rows[0]?.is_initial_admin === true;
  }

  async countActiveAdmins(excludeUserId?: string): Promise<number> {
    const result = await this.db.query<{ c: string }>(
      `SELECT COUNT(DISTINCT u.id)::text AS c
       FROM users u
       INNER JOIN user_roles ur ON ur.user_id = u.id
       INNER JOIN roles r ON r.id = ur.role_id
       WHERE r.name = 'ADMIN' AND u.active = true AND u.id <> $1`,
      [excludeUserId ?? "00000000-0000-0000-0000-000000000000"],
    );
    return Number(result.rows[0]?.c ?? "0");
  }

  async setRolesGuarded(userId: string, roles: Role[]): Promise<void> {
    const target = await this.requireById(userId);
    if (await this.isInitialAdmin(userId)) {
      throw AppError.validation(
        `The initial administrator account "${target.username}" is the system's root account. Its role cannot be changed.`,
      );
    }
    const isCurrentlyAdmin = target.roles.includes("ADMIN");
    if (isCurrentlyAdmin && !roles.includes("ADMIN") && (await this.countActiveAdmins(userId)) === 0) {
      throw AppError.validation(
        `Cannot demote "${target.username}": they are the only active administrator. Create or promote another administrator first.`,
      );
    }
    await this.setRoles(userId, roles);
  }

  async deleteGuarded(userId: string): Promise<void> {
    const target = await this.requireById(userId);
    if (await this.isInitialAdmin(userId)) {
      throw AppError.validation(
        `The initial administrator account "${target.username}" cannot be deleted.`,
      );
    }
    if (target.roles.includes("ADMIN") && (await this.countActiveAdmins(userId)) === 0) {
      throw AppError.validation(
        `Cannot delete "${target.username}": they are the only active administrator. Create or promote another administrator first.`,
      );
    }
    await this.delete(userId);
  }

  async canDeactivate(userId: string): Promise<boolean> {
    const target = await this.requireById(userId);
    if (await this.isInitialAdmin(userId)) return false;
    if (target.roles.includes("ADMIN") && (await this.countActiveAdmins(userId)) === 0) return false;
    return true;
  }

  async findByUsername(username: string): Promise<UserWithRoles | null> {
    const result = await this.selectWhere("WHERE u.username = $1", [username]);
    return assembleUsers(result.rows)[0] ?? null;
  }

  async findById(id: string): Promise<UserWithRoles | null> {
    if (!isUuid(id)) return null;
    const result = await this.selectWhere("WHERE u.id = $1", [id]);
    return assembleUsers(result.rows)[0] ?? null;
  }

  async requireById(id: string, q: Queryable = this.db): Promise<UserWithRoles> {
    if (!isUuid(id)) throw AppError.notFound("User not found");
    const result = await q.query<UserRoleRow>(
      `SELECT u.*, r.name AS role_name
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE u.id = $1`,
      [id],
    );
    const user = assembleUsers(result.rows)[0];
    if (!user) throw AppError.notFound("User not found");
    return user;
  }

  private async selectWhere(where: string, params: unknown[]): Promise<{ rows: UserRoleRow[] }> {
    return this.db.query<UserRoleRow>(
      `SELECT u.*, r.name AS role_name
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       ${where}`,
      params,
    );
  }

  async list(): Promise<UserWithRoles[]> {
    const result = await this.db.query<UserRoleRow>(
      `SELECT u.*, r.name AS role_name
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       ORDER BY u.created_at ASC`,
    );
    return assembleUsers(result.rows);
  }

  async setActive(userId: string, active: boolean): Promise<void> {
    await this.db.query("UPDATE users SET active = $2, updated_at = NOW() WHERE id = $1", [
      userId,
      active,
    ]);
  }

  async recordFailedLogin(username: string, maxAttempts: number, lockMinutes: number): Promise<{ locked: boolean; remaining: number }> {
    const user = await this.findByUsername(username);
    if (!user) return { locked: true, remaining: -1 };
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return {
        locked: true,
        remaining: Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000),
      };
    }
    const attempts = user.failedAttempts + 1;
    if (attempts >= maxAttempts) {
      await this.db.query(
        "UPDATE users SET failed_attempts = $2, locked_until = NOW() + ($3 || ' minutes')::interval, updated_at = NOW() WHERE id = $1",
        [user.id, attempts, lockMinutes],
      );
      return { locked: true, remaining: lockMinutes };
    }
    await this.db.query(
      "UPDATE users SET failed_attempts = $2, updated_at = NOW() WHERE id = $1",
      [user.id, attempts],
    );
    return { locked: false, remaining: maxAttempts - attempts };
  }

  async clearFailedLogins(username: string): Promise<void> {
    await this.db.query(
      "UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE username = $1",
      [username],
    );
  }

  async setLastLogin(userId: string): Promise<void> {
    await this.db.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [userId]);
  }

  async delete(userId: string): Promise<void> {
    await this.db.query("DELETE FROM users WHERE id = $1", [userId]);
  }

  async changePassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.query("UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1", [
      userId,
      passwordHash,
    ]);
  }
}

function assembleUsers(rows: UserRoleRow[]): UserWithRoles[] {
  const map = new Map<string, UserWithRoles>();
  for (const row of rows) {
    let user = map.get(row.id);
    if (!user) {
      user = {
        id: row.id,
        username: row.username,
        email: row.email,
        givenName: row.given_name,
        passwordHash: row.password_hash,
        active: row.active,
        isInitialAdmin: row.is_initial_admin === true,
        failedAttempts: row.failed_attempts,
        lockedUntil: row.locked_until,
        lastLoginAt: row.last_login_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        roles: [],
      };
      map.set(row.id, user);
    }
    if (row.role_name && validRoles([row.role_name]).length === 1 && !user.roles.includes(row.role_name as Role)) {
      user.roles.push(row.role_name as Role);
    }
  }
  return [...map.values()];
}

export function toPublicUser(user: UserWithRoles): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    givenName: user.givenName,
    roles: user.roles,
    active: user.active,
    isInitialAdmin: user.isInitialAdmin,
    createdAt: toIso(user.createdAt) ?? "",
    lastLoginAt: toIso(user.lastLoginAt),
  };
}