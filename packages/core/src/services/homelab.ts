import { randomBytes, createHash } from "node:crypto";
import net from "node:net";
import { newId } from "../util/misc.js";
import type { Queryable } from "../db/pool.js";
import { AppError } from "../util/errors.js";
import type { AuditService } from "./audit.js";
import type { VmsRepository } from "./vms.js";
import type { ProxmoxClient } from "../proxmox/client.js";
import type { GuacamoleService } from "./guacamole.js";
import type { Logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Scheduled power actions
// ---------------------------------------------------------------------------

export const SCHEDULE_ACTIONS = ["start", "stop", "restart"] as const;
export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];

export interface VmSchedule {
  id: string;
  vmId: string;
  action: ScheduleAction;
  minute: number;
  hour: number;
  /** '*' (daily) or comma-separated weekday numbers, 0=Sunday. */
  days: string;
  enabled: boolean;
  lastRunAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

export function parseScheduleDays(days: string): number[] | null {
  if (days.trim() === "*") return null;
  const raw = days.split(",");
  const parts = raw.map((p) => (p.trim() === "" ? NaN : Number(p.trim())));
  if (!raw.length || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) {
    throw AppError.validation("days must be '*' or comma-separated weekday numbers 0-6");
  }
  return [...new Set(parts as number[])].sort((a, b) => a - b);
}

/** Pure due-check, extracted for deterministic tests. */
export function scheduleDueNow(
  schedule: { minute: number; hour: number; days: string; enabled: boolean; lastRunAt: Date | null },
  now = new Date(),
): boolean {
  if (!schedule.enabled) return false;
  if (now.getMinutes() !== schedule.minute || now.getHours() !== schedule.hour) return false;
  const days = parseScheduleDays(schedule.days);
  if (days && !days.includes(now.getDay())) return false;
  if (schedule.lastRunAt) {
    const last = new Date(schedule.lastRunAt);
    if (
      last.getFullYear() === now.getFullYear() &&
      last.getMonth() === now.getMonth() &&
      last.getDate() === now.getDate() &&
      last.getHours() === now.getHours() &&
      last.getMinutes() === now.getMinutes()
    ) {
      return false;
    }
  }
  return true;
}

function toSchedule(row: Record<string, unknown>): VmSchedule {
  return {
    id: String(row.id),
    vmId: String(row.vm_id),
    action: row.action as ScheduleAction,
    minute: Number(row.minute),
    hour: Number(row.hour),
    days: String(row.days),
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at as string) : null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}

export async function listSchedules(db: Queryable): Promise<VmSchedule[]> {
  const result = await db.query("SELECT * FROM vm_schedules ORDER BY hour ASC, minute ASC");
  return result.rows.map(toSchedule);
}

export async function createSchedule(
  db: Queryable,
  input: { vmId: string; action: string; minute: number; hour: number; days?: string; createdBy?: string | null },
): Promise<VmSchedule> {
  if (!SCHEDULE_ACTIONS.includes(input.action as ScheduleAction)) {
    throw AppError.validation(`action must be one of: ${SCHEDULE_ACTIONS.join(", ")}`);
  }
  if (!Number.isInteger(input.minute) || input.minute < 0 || input.minute > 59) {
    throw AppError.validation("minute must be 0-59");
  }
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) {
    throw AppError.validation("hour must be 0-23");
  }
  const days = input.days ?? "*";
  parseScheduleDays(days);
  const id = newId();
  await db.query(
    `INSERT INTO vm_schedules (id, vm_id, action, minute, hour, days, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
    [id, input.vmId, input.action, input.minute, input.hour, days, input.createdBy ?? null],
  );
  const rows = await db.query("SELECT * FROM vm_schedules WHERE id = $1", [id]);
  return toSchedule(rows.rows[0] as Record<string, unknown>);
}

export async function deleteSchedule(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query("DELETE FROM vm_schedules WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function setScheduleEnabled(db: Queryable, id: string, enabled: boolean): Promise<void> {
  await db.query("UPDATE vm_schedules SET enabled = $2 WHERE id = $1", [id, enabled]);
}

export interface ScheduleRunDeps {
  db: Queryable;
  vms: Pick<VmsRepository, "requireById">;
  getProxmoxClient: () => Promise<ProxmoxClient>;
  audit: Pick<AuditService, "record">;
  logger: Logger;
}

/** Execute every due schedule once. Failures are audited per schedule; one bad VM never stops the rest. */
export async function runDueSchedules(deps: ScheduleRunDeps, now = new Date()): Promise<{ ran: number; failed: number }> {
  const schedules = await listSchedules(deps.db);
  let ran = 0;
  let failed = 0;
  for (const schedule of schedules) {
    if (!scheduleDueNow(schedule, now)) continue;
    // Claim first so overlapping tickers cannot double-fire the same minute.
    await deps.db.query("UPDATE vm_schedules SET last_run_at = NOW() WHERE id = $1", [schedule.id]);
    ran += 1;
    try {
      const vm = await deps.vms.requireById(schedule.vmId);
      const proxmox = await deps.getProxmoxClient();
      if (schedule.action === "start") {
        const upid = await proxmox.start(vm.node, vm.vmid);
        if (upid) await proxmox.waitForTask(vm.node, upid, 120000);
      } else if (schedule.action === "stop") {
        const upid = await proxmox.stop(vm.node, vm.vmid, 60);
        if (upid) await proxmox.waitForTask(vm.node, upid, 120000);
      } else {
        const upid = await proxmox.reboot(vm.node, vm.vmid);
        if (upid) await proxmox.waitForTask(vm.node, upid, 120000);
      }
      await deps.audit.record({
        event: "SCHEDULE_RUN",
        vmId: vm.id,
        detail: { scheduleId: schedule.id, action: schedule.action, result: "ok" },
      });
    } catch (err) {
      failed += 1;
      deps.logger.warn(
        { scheduleId: schedule.id, error: err instanceof Error ? err.message : String(err) },
        "scheduled power action failed",
      );
      try {
        await deps.audit.record({
          event: "SCHEDULE_RUN",
          vmId: schedule.vmId,
          detail: {
            scheduleId: schedule.id,
            action: schedule.action,
            result: "failed",
            error: err instanceof Error ? err.message : String(err),
          },
        });
      } catch {
        // audit must never break the ticker loop
      }
    }
  }
  return { ran, failed };
}

// ---------------------------------------------------------------------------
// Share links (time-boxed, revocable Guacamole session URLs)
// ---------------------------------------------------------------------------

export interface ShareLink {
  id: string;
  vmId: string;
  protocol: string;
  expiresAt: Date;
  maxUses: number | null;
  useCount: number;
  revokedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createShareLink(
  db: Queryable,
  input: { vmId: string; protocol: string; expiresInMinutes: number; maxUses?: number | null; createdBy?: string | null },
): Promise<{ link: ShareLink; token: string }> {
  if (!Number.isFinite(input.expiresInMinutes) || input.expiresInMinutes < 5 || input.expiresInMinutes > 60 * 24 * 7) {
    throw AppError.validation("expiresInMinutes must be 5-10080 (5 minutes to 7 days)");
  }
  if (input.maxUses !== undefined && input.maxUses !== null && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) {
    throw AppError.validation("maxUses must be a positive integer");
  }
  const token = randomBytes(32).toString("hex");
  const id = newId();
  const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60 * 1000);
  await db.query(
    `INSERT INTO shared_links (id, vm_id, protocol, token_hash, expires_at, max_uses, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.vmId, input.protocol, hashShareToken(token), expiresAt, input.maxUses ?? null, input.createdBy ?? null],
  );
  const link = await getShareLink(db, id);
  if (!link) throw AppError.notFound("Share link creation failed");
  return { link, token };
}

export async function getShareLink(db: Queryable, id: string): Promise<ShareLink | null> {
  const result = await db.query("SELECT * FROM shared_links WHERE id = $1", [id]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return toShareLink(row);
}

function toShareLink(row: Record<string, unknown>): ShareLink {
  return {
    id: String(row.id),
    vmId: String(row.vm_id),
    protocol: String(row.protocol),
    expiresAt: new Date(row.expires_at as string),
    maxUses: row.max_uses === null || row.max_uses === undefined ? null : Number(row.max_uses),
    useCount: Number(row.use_count ?? 0),
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}

export async function listShareLinks(db: Queryable, createdBy?: string | null): Promise<ShareLink[]> {
  const result =
    createdBy === undefined
      ? await db.query("SELECT * FROM shared_links ORDER BY created_at DESC")
      : await db.query("SELECT * FROM shared_links WHERE created_by = $1 ORDER BY created_at DESC", [createdBy]);
  return result.rows.map((r) => toShareLink(r as Record<string, unknown>));
}

export async function revokeShareLink(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query("UPDATE shared_links SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL", [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Validate a presented token and consume one use. Returns the grant, or null
 * when unknown/expired/revoked/exhausted. Uses a timing-safe hash comparison
 * over the lookup so validity cannot be probed byte-by-byte (the UNIQUE index
 * still makes lookup O(1)).
 */
export async function redeemShareLink(db: Queryable, token: string): Promise<ShareLink | null> {
  if (!token || typeof token !== "string" || token.length > 256) return null;
  const now = new Date();
  const candidates = await db.query(
    "SELECT * FROM shared_links WHERE revoked_at IS NULL AND expires_at > $1",
    [now],
  );
  const wanted = hashShareToken(token);
  let match: Record<string, unknown> | null = null;
  for (const row of candidates.rows as Record<string, unknown>[]) {
    const candidate = String(row.token_hash ?? "");
    if (candidate.length !== wanted.length) continue;
    let diff = 0;
    for (let i = 0; i < wanted.length; i++) diff |= wanted.charCodeAt(i) ^ candidate.charCodeAt(i);
    if (diff === 0) {
      match = row;
      break;
    }
  }
  if (!match) return null;
  const link = toShareLink(match);
  if (link.maxUses !== null && link.useCount >= link.maxUses) return null;
  const updated = await db.query(
    "UPDATE shared_links SET use_count = use_count + 1 WHERE id = $1 AND (max_uses IS NULL OR use_count < max_uses) RETURNING *",
    [link.id],
  );
  if (!updated.rows.length) return null;
  return toShareLink(updated.rows[0] as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Service discovery (port-scan snapshots)
// ---------------------------------------------------------------------------

export const KNOWN_SERVICE_PORTS: Readonly<Record<number, string>> = {
  22: "SSH",
  80: "HTTP",
  443: "HTTPS",
  3000: "Web UI",
  3306: "MySQL/MariaDB",
  3389: "RDP",
  5432: "PostgreSQL",
  5900: "VNC",
  6379: "Redis",
  8080: "Web UI (alt)",
  8123: "Home Assistant",
  8443: "HTTPS (alt)",
  3001: "Web UI",
  5000: "Web UI",
  8000: "Web UI",
  8006: "Proxmox VE",
  8096: "Jellyfin",
  9000: "Portainer",
  9090: "Cockpit/Prometheus",
  1883: "MQTT",
};

export interface DiscoveredService {
  port: number;
  service: string;
  checkedAt: Date;
}

async function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const sock = net.connect(port, host);
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on("connect", () => finish(true));
    sock.on("error", () => finish(false));
  });
}

/** TCP-scan well-known ports with bounded concurrency. Never throws. */
export async function scanVmServices(
  ip: string,
  opts?: { ports?: number[]; timeoutMs?: number; concurrency?: number },
): Promise<DiscoveredService[]> {
  const ports = opts?.ports ?? Object.keys(KNOWN_SERVICE_PORTS).map(Number);
  const timeoutMs = opts?.timeoutMs ?? 1500;
  const concurrency = opts?.concurrency ?? 8;
  const found: DiscoveredService[] = [];
  const queue = [...ports];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const port = queue.shift();
      if (port === undefined) return;
      try {
        if (await probePort(ip, port, timeoutMs)) {
          found.push({ port, service: KNOWN_SERVICE_PORTS[port] ?? "Unknown", checkedAt: new Date() });
        }
      } catch {
        // a single port must never fail the whole scan
      }
    }
  });
  await Promise.all(workers);
  return found.sort((a, b) => a.port - b.port);
}

export async function storeVmServices(db: Queryable, vmId: string, services: DiscoveredService[]): Promise<void> {
  await db.query("DELETE FROM vm_services WHERE vm_id = $1", [vmId]);
  for (const service of services) {
    await db.query("INSERT INTO vm_services (vm_id, port, service) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
      vmId,
      service.port,
      service.service,
    ]);
  }
}

export async function listVmServices(db: Queryable, vmId: string): Promise<DiscoveredService[]> {
  const result = await db.query("SELECT port, service, checked_at FROM vm_services WHERE vm_id = $1 ORDER BY port ASC", [
    vmId,
  ]);
  return result.rows.map((r) => ({
    port: Number((r as Record<string, unknown>).port),
    service: String((r as Record<string, unknown>).service),
    checkedAt: new Date((r as Record<string, unknown>).checked_at as string),
  }));
}

// ---------------------------------------------------------------------------
// Connection health snapshots
// ---------------------------------------------------------------------------

export interface ConnectionHealth {
  vmId: string;
  protocol: string;
  reachable: boolean;
  authenticated: boolean | null;
  detail: string;
  checkedAt: Date;
}

export async function storeConnectionHealth(
  db: Queryable,
  vmId: string,
  protocol: string,
  result: { reachable: boolean; authenticated: boolean | null; detail: string },
): Promise<void> {
  await db.query(
    `INSERT INTO connection_health (vm_id, protocol, reachable, authenticated, detail, checked_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (vm_id, protocol) DO UPDATE SET
       reachable = EXCLUDED.reachable, authenticated = EXCLUDED.authenticated,
       detail = EXCLUDED.detail, checked_at = NOW()`,
    [vmId, protocol, result.reachable, result.authenticated, result.detail.slice(0, 500)],
  );
}

export async function listConnectionHealth(db: Queryable, vmIds: string[]): Promise<ConnectionHealth[]> {
  if (!vmIds.length) return [];
  const placeholders = vmIds.map((_, i) => `$${i + 1}`).join(", ");
  const result = await db.query(
    `SELECT * FROM connection_health WHERE vm_id IN (${placeholders}) ORDER BY checked_at DESC`,
    vmIds,
  );
  return result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      vmId: String(row.vm_id),
      protocol: String(row.protocol),
      reachable: Boolean(row.reachable),
      authenticated: row.authenticated === null || row.authenticated === undefined ? null : Boolean(row.authenticated),
      detail: String(row.detail ?? ""),
      checkedAt: new Date(row.checked_at as string),
    };
  });
}

/** Run the full diagnostics for every stored connection of one VM and snapshot the results. */
export async function checkVmHealth(
  db: Queryable,
  guac: Pick<GuacamoleService, "testConnectionRecord">,
  vmId: string,
): Promise<ConnectionHealth[]> {
  const records = await db.query<{ protocol: string }>("SELECT DISTINCT protocol FROM guacamole_connections WHERE vm_id = $1", [
    vmId,
  ]);
  const out: ConnectionHealth[] = [];
  for (const record of records.rows) {
    try {
      const result = await guac.testConnectionRecord(vmId, record.protocol as "ssh" | "rdp" | "vnc");
      await storeConnectionHealth(db, vmId, record.protocol, result);
      out.push({ vmId, protocol: record.protocol, reachable: result.reachable, authenticated: result.authenticated, detail: result.detail, checkedAt: new Date() });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await storeConnectionHealth(db, vmId, record.protocol, { reachable: false, authenticated: null, detail });
      out.push({ vmId, protocol: record.protocol, reachable: false, authenticated: null, detail, checkedAt: new Date() });
    }
  }
  return out;
}
