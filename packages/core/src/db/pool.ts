/* ---------------------------------------------------------------------------
 * pool.ts — PostgreSQL pool factory + the minimal query surface (Queryable).
 *
 * One pool per process; callers depend on Queryable (not pg.Pool) so unit
 * tests can substitute pg-mem. Defaults below are homelab-safe: localhost,
 * 10 pooled connections, 10s connect / 30s idle timeouts. No secrets live
 * here — credentials arrive via config/env at the call site.
 * ------------------------------------------------------------------------- */
import { Pool, type PoolConfig } from "pg";

/**
 * Build a pg Pool with ProxVM's homelab defaults. Every field falls back
 * individually so callers override only what differs per environment.
 */
export function createPgPool(config: PoolConfig): Pool {
  return new Pool({
    host: config.host ?? "127.0.0.1",
    port: config.port ?? 5432,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ?? false,
    max: config.max ?? 10,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10000,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
  });
}

// --- Minimal query surface -------------------------------------------------
/**
 * Smallest query contract the codebase needs. WHY an interface: repositories
 * and migrate.ts accept this instead of Pool, so pg-mem doubles for tests
 * without a live Postgres (pg-mem lacks FOR UPDATE — see attack-chains).
 */
export interface Queryable {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}