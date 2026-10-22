import { describe, expect, it, vi } from "vitest";
import { MIGRATIONS, runMigrations } from "./migrate.js";
import type { Logger } from "../util/logger.js";

// Silent logger: these tests assert call order, not log output.
const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

/**
 * Fake pool/client pair. The pool hands out one client; the client records
 * every statement so tests can assert lock/unlock ordering around the run.
 */
function fakePool(
  opts: { failOn?: (sql: string) => boolean; lockError?: unknown; existingIds?: string[] } = {},
) {
  const calls: string[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    const text = sql.trim();
    calls.push(text);
    if (opts.failOn?.(text)) throw new Error("migration exploded");
    if (opts.lockError && text.startsWith("SELECT pg_advisory_lock")) throw opts.lockError;
    if (text.includes("SELECT id FROM schema_migrations")) {
      const rows = (opts.existingIds ?? []).map((id) => ({ id }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release };
  const pool = { query, connect: vi.fn(async () => client) };
  return { pool, client, calls, release };
}

const indexOf = (calls: string[], needle: string) =>
  calls.findIndex((sql) => sql.startsWith(needle));

describe("runMigrations", () => {
  it("serializes the run behind an advisory lock and always releases the client", async () => {
    const { pool, calls, release } = fakePool();

    const applied = await runMigrations(pool as never, logger);

    expect(applied).toHaveLength(MIGRATIONS.length);
    const lockAt = indexOf(calls, "SELECT pg_advisory_lock");
    const firstBegin = indexOf(calls, "BEGIN");
    const lastCommit = calls.lastIndexOf("COMMIT");
    const unlockAt = indexOf(calls, "SELECT pg_advisory_unlock");
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(firstBegin);
    expect(unlockAt).toBeGreaterThan(lastCommit);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("unlocks and releases even when a migration fails", async () => {
    const { pool, calls, release } = fakePool({
      failOn: (sql) => sql.startsWith("INSERT INTO schema_migrations"),
    });

    await expect(runMigrations(pool as never, logger)).rejects.toThrow("migration exploded");

    expect(indexOf(calls, "ROLLBACK")).toBeGreaterThanOrEqual(0);
    expect(indexOf(calls, "SELECT pg_advisory_unlock")).toBeGreaterThanOrEqual(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("migrates without a lock when the backend has no advisory locks", async () => {
    const { pool, calls, release } = fakePool({
      lockError: Object.assign(new Error("function pg_advisory_lock(integer) does not exist"), {
        code: "42883",
      }),
    });

    const applied = await runMigrations(pool as never, logger);

    expect(applied).toHaveLength(MIGRATIONS.length);
    expect(indexOf(calls, "SELECT pg_advisory_unlock")).toBe(-1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("aborts the boot instead of migrating unlocked when the lock query really fails", async () => {
    const { pool, calls, release } = fakePool({
      lockError: Object.assign(new Error("connection terminated"), { code: "08006" }),
    });

    await expect(runMigrations(pool as never, logger)).rejects.toThrow("connection terminated");

    expect(indexOf(calls, "BEGIN")).toBe(-1);
    expect(indexOf(calls, "SELECT pg_advisory_unlock")).toBe(-1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("skips already-applied migrations", async () => {
    const { pool, calls } = fakePool({
      existingIds: MIGRATIONS.map((migration) => migration.id),
    });

    const applied = await runMigrations(pool as never, logger);

    expect(applied).toEqual([]);
    expect(indexOf(calls, "BEGIN")).toBe(-1);
  });
});
