// ---------------------------------------------------------------------------
// Health checks: point-in-time dependency probes for the status surface.
// - Each probe is timed and never throws: timed() converts errors to
//   { status: "ERROR", detail } so one down dependency does not hide the
//   rest of the results.
// - Worker liveness is Redis-heartbeat age (>30s = stale); Guacamole web is
//   checked with an SSRF-guarded fetch where only 5xx fails (4xx still
//   proves the app answers). No probe mutates state.
// ---------------------------------------------------------------------------
import type IORedis from "ioredis";
import type { Pool } from "pg";
import type { HealthCheckResult } from "@proxvm/shared";
import type { ProxmoxClient } from "../proxmox/client.js";
import type { GuacamoleDbClient } from "../guacamole/db.js";
import type { GuacamoleApiClient } from "../guacamole/api.js";
import type { SettingsService } from "./settings.js";
import { fetchWithSsrfGuard } from "../util/ssrf.js";

export interface HealthDeps {
  db: Pool;
  redis: IORedis;
  logger: unknown;
  settings: SettingsService;
  getProxmoxClient: () => Promise<ProxmoxClient>;
  getGuacDb: () => Promise<GuacamoleDbClient>;
  getGuacApi: () => Promise<GuacamoleApiClient | null>;
}

export const WORKER_HEARTBEAT_KEY = "proxvm:worker:heartbeat";

async function timed(name: string, fn: () => Promise<void>): Promise<HealthCheckResult> {
  const started = Date.now();
  const lastChecked = new Date().toISOString();
  try {
    await fn();
    return { name, status: "ONLINE", latencyMs: Date.now() - started, lastChecked, detail: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: "ERROR", latencyMs: Date.now() - started, lastChecked, detail: message };
  }
}

/**
 * Runs every dependency probe; each result is timed and errors become
 * ERROR rows so one outage never hides the remaining checks.
 */
export async function runHealthChecks(deps: HealthDeps): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  results.push(await timed("postgresql", async () => {
    await deps.db.query("SELECT 1");
  }));

  results.push(await timed("redis", async () => {
    const reply = await deps.redis.ping();
    if (reply !== "PONG") throw new Error(`unexpected PING response: ${String(reply)}`);
  }));

  results.push(await timed("worker", async () => {
    const heartbeat = await deps.redis.get(WORKER_HEARTBEAT_KEY);
    if (!heartbeat) throw new Error("no worker heartbeat recorded");
    const age = Date.now() - Number(heartbeat);
    if (age > 30000) throw new Error(`worker heartbeat is stale (${Math.round(age / 1000)}s old)`);
  }));

  results.push(await timed("proxmox", async () => {
    const client = await deps.getProxmoxClient();
    const version = await client.version();
    if (!version.version) throw new Error("Proxmox returned no version string");
  }));

  results.push(await timed("guacamole_database", async () => {
    const guacDb = await deps.getGuacDb();
    const check = await guacDb.testConnection();
    if (!check.ok) throw new Error(check.detail ?? "Guacamole database check failed");
  }));

  results.push(await timed("guacamole_web", async () => {
    const settings = await deps.settings.guacamole();
    if (!settings) throw new Error("Guacamole is not configured");
    const response = await fetchWithSsrfGuard(settings.url, { signal: AbortSignal.timeout(8000) }, 1);
    if (response.status >= 500) {
      throw new Error(`Guacamole web app returned HTTP ${response.status}`);
    }
  }));

  return results;
}

/** Records worker liveness (30s TTL); absence means the worker is down. */
export function setWorkerHeartbeat(redis: IORedis): void {
  void redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()), "EX", 30);
}