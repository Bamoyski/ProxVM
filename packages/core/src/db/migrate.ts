/* ---------------------------------------------------------------------------
 * migrate.ts — ordered, idempotent schema migration runner.
 *
 * MIGRATIONS is append-only and ordered: each entry runs once inside its own
 * transaction and records into schema_migrations. NEVER edit an applied
 * migration's SQL (fresh installs would diverge from upgraded ones) — add a
 * new numbered migration instead. Runs automatically on API boot.
 *
 * Concurrency: api and worker both boot at the same time and both call this,
 * so the whole run is serialized with a Postgres advisory lock. Without it
 * both processes read the same pending list and race: the loser fails on
 * schema_migrations_pkey, or on pg_type_typname_nsp_index when two CREATE
 * TABLEs for the same new table collide ("IF NOT EXISTS" is not atomic —
 * the existence check and the catalog insert are separate steps). That crash
 * was self-healing only because compose restarts the container; a slow boot
 * would instead fail the deploy's readiness check.
 *
 * The lock is session-scoped, so it is taken on a dedicated pooled client and
 * every migration statement runs on that same client. That also makes
 * BEGIN/COMMIT meaningful: through a Pool, sequential pool.query() calls can
 * land on different connections, so the per-migration transaction was never
 * guaranteed before.
 * ------------------------------------------------------------------------- */
import type { Queryable } from "./pool.js";
import type { Logger } from "../util/logger.js";

export interface Migration {
  id: string;
  name: string;
  sql: string;
}

// Arbitrary but stable app-wide key; must never change or two versions of the
// app could migrate concurrently while upgrading past each other.
const MIGRATION_LOCK_KEY = 7423001;

/** A client that may be released back to a pool (pg.PoolClient shape). */
type MigrationClient = Queryable & { release?: () => void };

/** Queryable that can hand out a dedicated connection (pg.Pool shape). */
type MigrationSource = Queryable & { connect?: () => Promise<MigrationClient> };

// --- Migration catalog (order matters: applied strictly top to bottom) -----
import { initialMigration } from "./migrations/001_initial.js";
import { vmsMigration } from "./migrations/002_vms.js";
import { jobsMigration } from "./migrations/003_jobs.js";
import { adminGuardMigration } from "./migrations/004_admin_vm_meta.js";
import { guacUserUniqueMigration } from "./migrations/005_guac_user_unique.js";
import { vmAccessActorMigration } from "./migrations/006_vm_access_actor.js";
import { iamMigration } from "./migrations/007_iam.js";
import { guacSessionTokensMigration } from "./migrations/008_guac_session_tokens.js";
import { homelabMigration } from "./migrations/009_homelab.js";
import { registrationMigration } from "./migrations/010_registration.js";
import { vmPrivacyMigration } from "./migrations/011_vm_privacy.js";
import { billingFoundationsMigration } from "./migrations/012_billing_foundations.js";
import { firewallIsolatedMigration } from "./migrations/013_firewall_isolated.js";
import { vmClassMigration } from "./migrations/014_vm_class.js";
import { startOnBootMigration } from "./migrations/015_start_on_boot.js";
import { vmIpUniqueMigration } from "./migrations/016_vm_ip_unique.js";
import { pbsBackupsMigration } from "./migrations/017_pbs_backups.js";
import { notificationsMigration } from "./migrations/020_notifications.js";
import { guacDirectLoginMigration } from "./migrations/021_guac_direct_login.js";
import { guestRoleMigration } from "./migrations/022_guest_role.js";
import { driftMigration } from "./migrations/023_drift.js";
import { driftPermissionMigration } from "./migrations/024_drift_permission.js";
import { sshHostKeysMigration } from "./migrations/018_ssh_host_keys.js";
import { csrfTokenDerivationMigration } from "./migrations/019_csrf_token_derivation.js";

export const MIGRATIONS: Migration[] = [
  { id: "001", name: "initial", sql: initialMigration },
  { id: "002", name: "vms", sql: vmsMigration },
  { id: "003", name: "jobs", sql: jobsMigration },
  { id: "004", name: "admin_guard_and_vm_meta", sql: adminGuardMigration },
  { id: "005", name: "guac_user_unique", sql: guacUserUniqueMigration },
  { id: "006", name: "vm_access_actor", sql: vmAccessActorMigration },
  { id: "007", name: "iam", sql: iamMigration },
  { id: "008", name: "guac_session_tokens", sql: guacSessionTokensMigration },
  { id: "009", name: "homelab", sql: homelabMigration },
  { id: "010", name: "registration", sql: registrationMigration },
  { id: "011", name: "vm_privacy", sql: vmPrivacyMigration },
  { id: "012", name: "billing_foundations", sql: billingFoundationsMigration },
  { id: "013", name: "firewall_isolated", sql: firewallIsolatedMigration },
  { id: "014", name: "vm_class", sql: vmClassMigration },
  { id: "015", name: "start_on_boot", sql: startOnBootMigration },
  { id: "016", name: "vm_ip_unique", sql: vmIpUniqueMigration },
  { id: "017", name: "pbs_backups", sql: pbsBackupsMigration },
  { id: "018", name: "ssh_host_keys", sql: sshHostKeysMigration },
  { id: "019", name: "csrf_token_derivation", sql: csrfTokenDerivationMigration },
  { id: "020", name: "notifications", sql: notificationsMigration },
  { id: "021", name: "guac_direct_login", sql: guacDirectLoginMigration },
  { id: "022", name: "guest_role", sql: guestRoleMigration },
  { id: "023", name: "drift", sql: driftMigration },
  { id: "024", name: "drift_permission", sql: driftPermissionMigration },
];

// --- Runner ----------------------------------------------------------------
/**
 * Apply every pending migration in order, returning the ids applied now.
 *
 * WHY one transaction per migration (not one for all): a failure rolls back
 * only the bad migration, leaving earlier ones recorded so the next boot
 * retries exactly where it stopped instead of replaying everything.
 */
export async function runMigrations(db: Queryable, logger: Logger): Promise<string[]> {
  const source = db as MigrationSource;
  // Test doubles (pg-mem adapters, fakes) may have no pool to check out from;
  // a single-process run needs no cross-process lock, so migrate directly.
  if (typeof source.connect !== "function") return applyMigrations(source, logger);

  const client = await source.connect();
  let locked = false;
  try {
    locked = await acquireLock(client, logger);
    return await applyMigrations(client, logger);
  } finally {
    // Unlock before release: a session-scoped lock outlives the statement, so
    // handing the connection back while still holding it would block the rest
    // of the fleet until that pooled connection is closed.
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "failed to release migration advisory lock; connection will be dropped",
        );
      }
    }
    client.release?.();
  }
}

/** Take the cross-process migration lock; false when the backend lacks it. */
async function acquireLock(client: MigrationClient, logger: Logger): Promise<boolean> {
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    return true;
  } catch (err) {
    // pg-mem (unit tests) and other query doublings do not implement advisory
    // locks. That is safe: those runs are single-process. Any other failure is
    // real and must abort the boot instead of migrating unlocked.
    if (!isUnsupportedLock(err)) throw err;
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "advisory locks unavailable; running migrations without a cross-process lock",
    );
    return false;
  }
}

/** True for "backend has no advisory locks", false for a real lock failure. */
function isUnsupportedLock(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "42883" || code === "0A000") return true; // undefined_function, feature_not_supported
  const message = err instanceof Error ? err.message : String(err);
  // pg-mem reports a missing function without an error code, with a HINT
  // paragraph after the message, so match on the shape rather than the code.
  return (
    /advisory_? ?lock/i.test(message) &&
    /does not exist|not supported|not implemented|unknown/i.test(message)
  );
}

async function applyMigrations(db: Queryable, logger: Logger): Promise<string[]> {
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
