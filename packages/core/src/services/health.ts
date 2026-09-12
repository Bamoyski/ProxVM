import type IORedis from "ioredis";
import type { Pool } from "pg";
import type { HealthCheckResult } from "@proxvm/shared";
import type { ProxmoxClient } from "../proxmox/client.js";
import type { GuacamoleDbClient } from "../guacamole/db.js";
import type { GuacamoleApiClient } from "../guacamole/api.js";
import type { SettingsService } from "./settings.js";

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
    const response = await fetch(settings.url, { signal: AbortSignal.timeout(8000), redirect: "follow" });
    if (response.status >= 500) {
      throw new Error(`Guacamole web app returned HTTP ${response.status}`);
    }
  }));

  return results;
}

export function setWorkerHeartbeat(redis: IORedis): void {
  void redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()), "EX", 30);
}