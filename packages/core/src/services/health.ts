// ---------------------------------------------------------------------------
// Health checks: point-in-time dependency probes for the status surface.
// - Each probe is timed and never throws: timed() converts errors to
//   { status: "ERROR", detail } so one down dependency does not hide the
//   rest of the results.
// - Worker liveness is Redis-heartbeat age (>30s = stale); Guacamole web is
//   checked with an SSRF-guarded fetch where only 5xx fails (4xx still
//   proves the app answers). No probe mutates state.
// - Optional integrations (PBS, Gotify, tunnels) report UNCONFIGURED when
//   not set up — never ERROR — so the dashboard shows a muted gap instead
//   of an outage, and the transition-alert ticker stays silent.
// - Error details are fixed generic strings: they surface to every
//   health.read role, so they must never carry URLs, hostnames, or anything
//   infra-specific. Admins drill into the linked settings page for detail.
// ---------------------------------------------------------------------------
import type IORedis from "ioredis";
import type { Pool } from "pg";
import type { HealthCheckResult } from "@proxvm/shared";
import type { ProxmoxClient } from "../proxmox/client.js";
import type { GuacamoleDbClient } from "../guacamole/db.js";
import type { GuacamoleApiClient } from "../guacamole/api.js";
import type { ProxmoxBackupClient } from "../pbs/client.js";
import { CloudflareClient } from "../cloudflare/client.js";
import { getCloudflareConfig } from "../services/domains.js";
import { getGotifyConfig } from "../services/gotify.js";
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
  getPbsClient: () => Promise<ProxmoxBackupClient | null>;
}

export const WORKER_HEARTBEAT_KEY = "proxvm:worker:heartbeat";

/**
 * Wraps a probe with timing and throw-to-ERROR conversion. A probe that ends
 * cleanly is ONLINE; returning a partial ({ status, detail }) overrides both,
 * which is how UNCONFIGURED optional services report without throwing.
 */
type ProbeOutcome = Partial<Pick<HealthCheckResult, "status" | "detail">> | void;
async function timed(name: string, fn: () => Promise<ProbeOutcome>): Promise<HealthCheckResult> {
  const started = Date.now();
  const lastChecked = new Date().toISOString();
  try {
    const extra = await fn();
    return { name, status: extra?.status ?? "ONLINE", latencyMs: Date.now() - started, lastChecked, detail: extra?.detail ?? null };
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

  // -- Optional integrations -------------------------------------------------
  // PBS: a version() round-trip proves URL + token both work. Transport and
  // auth failures look identical and stay generic — the raw error text can
  // carry the PBS URL, and probe details reach every health.read role.
  results.push(await timed("pbs", async () => {
    const client = await deps.getPbsClient();
    if (!client) {
      return { status: "UNCONFIGURED" as const, detail: "PBS is not configured — backups are not running." };
    }
    let version: { version: string };
    try {
      version = await client.version();
    } catch {
      throw new Error("PBS unreachable or rejected credentials (check Settings → Backups)");
    }
    if (!version.version) throw new Error("PBS returned no version string (check Settings → Backups)");
    return { detail: `PBS version ${version.version}` };
  }));

  // Gotify: SSRF-guarded fetch on the base URL; any response < 500 proves the
  // server answers (same rule as guacamole_web). Disabled or half-configured
  // is a deliberate state, not an outage, so it stays UNCONFIGURED.
  results.push(await timed("gotify_push", async () => {
    const cfg = await getGotifyConfig(deps.settings);
    if (!cfg.enabled) {
      return { status: "UNCONFIGURED" as const, detail: "Gotify push is not enabled (Settings → Notifications)." };
    }
    if (!cfg.url || !cfg.hasToken) {
      return { status: "UNCONFIGURED" as const, detail: "Gotify URL/token incomplete (Settings → Notifications)." };
    }
    let response: Response;
    try {
      response = await fetchWithSsrfGuard(cfg.url, { signal: AbortSignal.timeout(8000) }, 1);
    } catch {
      throw new Error("Gotify unreachable — admin alerts may not deliver (check Settings → Notifications)");
    }
    if (response.status >= 500) {
      throw new Error(`Gotify returned HTTP ${response.status} — admin alerts may not deliver`);
    }
    return { detail: "Push channel reachable" };
  }));

  // Cloudflare tunnels: token + account required to even ask; a configured
  // tunnel in anything but "healthy" IS an outaged public URL, not just a
  // soft integration problem.
  results.push(await timed("cloudflare_tunnels", async () => {
    const cf = await getCloudflareConfig(deps.settings);
    if (!cf.apiToken) {
      return { status: "UNCONFIGURED" as const, detail: "Cloudflare is not configured (no API token)." };
    }
    if (!cf.accountId) {
      return { status: "UNCONFIGURED" as const, detail: "Cloudflare account ID missing (Settings → Domains)." };
    }
    const client = new CloudflareClient({ token: cf.apiToken });
    const tunnels = await client.listTunnels(cf.accountId).catch((err: unknown) => {
      // Fixed message: the raw error can carry API payload text unfit for a
      // broad audience; the status code alone doesn't help here either.
      void err;
      throw new Error("Cloudflare API unreachable or token invalid (Settings → Domains)");
    });
    const healthyCount = tunnels.filter((t) => t.status === "healthy").length;
    if (!cf.tunnelId) {
      return { detail: `${healthyCount}/${tunnels.length} tunnel(s) healthy (no tunnel selected in settings)` };
    }
    const own = tunnels.find((t) => t.id === cf.tunnelId);
    if (!own) {
      throw new Error(`Configured tunnel not found among the account's ${tunnels.length} tunnel(s)`);
    }
    if (own.status !== "healthy") {
      throw new Error(`Tunnel "${own.name}" is '${own.status ?? "unknown"}' — cloudflared may not be running`);
    }
    return { detail: `Tunnel "${own.name}" healthy (${healthyCount}/${tunnels.length} healthy)` };
  }));

  return results;
}

/** Records worker liveness (30s TTL); absence means the worker is down. */
export function setWorkerHeartbeat(redis: IORedis): void {
  void redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()), "EX", 30);
}