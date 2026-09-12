import type { Queryable } from "./pool.js";
import type { Logger } from "../util/logger.js";

export interface Migration {
  id: string;
  name: string;
  sql: string;
}

import { initialMigration } from "./migrations/001_initial.js";
import { vmsMigration } from "./migrations/002_vms.js";
import { jobsMigration } from "./migrations/003_jobs.js";
import { adminGuardMigration } from "./migrations/004_admin_vm_meta.js";
import { guacUserUniqueMigration } from "./migrations/005_guac_user_unique.js";
import { vmAccessActorMigration } from "./migrations/006_vm_access_actor.js";
import { iamMigration } from "./migrations/007_iam.js";

export const MIGRATIONS: Migration[] = [
  { id: "001", name: "initial", sql: initialMigration },
  { id: "002", name: "vms", sql: vmsMigration },
  { id: "003", name: "jobs", sql: jobsMigration },
  { id: "004", name: "admin_guard_and_vm_meta", sql: adminGuardMigration },
  { id: "005", name: "guac_user_unique", sql: guacUserUniqueMigration },
  { id: "006", name: "vm_access_actor", sql: vmAccessActorMigration },
  { id: "007", name: "iam", sql: iamMigration },
];

export async function runMigrations(db: Queryable, logger: Logger): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const applied = new Set<string>();
  const existing = await db.query<{ id: string }>("SELECT id FROM schema_migrations");
  for (const row of existing.rows) applied.add(row.id);

  const appliedNow: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await db.query("BEGIN");
    try {
      await db.query(migration.sql);
      await db.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [
        migration.id,
        migration.name,
      ]);
      await db.query("COMMIT");
      appliedNow.push(migration.id);
      logger.info({ migration: migration.id }, "migration applied");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
  }
  return appliedNow;
}