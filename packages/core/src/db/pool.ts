import { Pool, type PoolConfig } from "pg";

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

export interface Queryable {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}