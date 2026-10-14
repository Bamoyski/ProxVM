// ---------------------------------------------------------------------------
// Backups supplement: overview + snapshot projection helpers (see state-
// machine contract above for PENDING -> RUNNING -> OK|FAILED ownership).
// - Ticker phases stay separated (queue due, start pending, finalize
//   running) with per-phase try/catch so one phase never starves the rest.
// - Creator re-auth gates both queueing and starting: revoked/disabled
//   owners skip with BACKUP_SKIPPED audit instead of running orphaned jobs.
// - Retention chains a prune run only after a successful backup with
//   keepLast set; PBS failures degrade overview/snapshot reads to nulls,
//   never to a failed page.
// ---------------------------------------------------------------------------
import { newId } from "../util/misc.js";
import type { Queryable } from "../db/pool.js";
import { AppError } from "../util/errors.js";
import { hasPermission } from "./rbac.js";
import { resolveEffectiveAccess } from "./iam.js";
import { notify, ADMIN_AUDIENCE } from "./notifications.js";
import { sendGotifyMessage } from "./gotify.js";
import { parseScheduleDays, scheduleDueNow } from "./homelab.js";
import type { UsersService } from "./users.js";
import type { VmsRepository } from "./vms.js";
import type { AuditService } from "./audit.js";
import type { SettingsService } from "./settings.js";
import type { ProxmoxClient } from "../proxmox/client.js";
import type { ProxmoxBackupClient } from "../pbs/client.js";
import type { Logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// PBS backup schedules + crash-safe run execution.
//
// State machine per run: PENDING → RUNNING → OK|FAILED. Triggers (manual or
// scheduled) only ever create PENDING rows and return immediately; the
// minute ticker claims them, starts the vzdump/prune task, and later
// finalizes by polling. A crashed process resumes where it left off —
// PENDING and RUNNING rows are picked up again on the next tick.
// ---------------------------------------------------------------------------

export const BACKUP_MODES = ["snapshot", "suspend", "stop"] as const;
export type BackupMode = (typeof BACKUP_MODES)[number];

export const BACKUP_KINDS = ["backup", "prune"] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BACKUP_STATUSES = ["PENDING", "RUNNING", "OK", "FAILED"] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

/** Max queued+active runs per VM: bounds pile-up from tight schedules. */
export const MAX_ACTIVE_BACKUP_RUNS = 3;

const STORAGE_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export interface BackupSchedule {
  id: string;
  vmId: string;
  mode: BackupMode;
  storage: string;
  datastore: string | null;
  minute: number;
  hour: number;
  days: string;
  keepLast: number | null;
  enabled: boolean;
  lastRunAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface BackupRun {
  id: string;
  vmId: string;
  scheduleId: string | null;
  kind: BackupKind;
  mode: BackupMode;
  storage: string;
  datastore: string | null;
  keepLast: number | null;
  status: BackupStatus;
  upid: string | null;
  error: string | null;
  createdBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

function toSchedule(row: Record<string, unknown>): BackupSchedule {
  return {
    id: String(row.id),
    vmId: String(row.vm_id),
    mode: row.mode as BackupMode,
    storage: String(row.storage),
    datastore: (row.datastore as string | null) ?? null,
    minute: Number(row.minute),
    hour: Number(row.hour),
    days: String(row.days),
    keepLast: row.keep_last === null || row.keep_last === undefined ? null : Number(row.keep_last),
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at as string) : null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}

function toRun(row: Record<string, unknown>): BackupRun {
  return {
    id: String(row.id),
    vmId: String(row.vm_id),
    scheduleId: (row.schedule_id as string | null) ?? null,
    kind: (row.kind as BackupKind) ?? "backup",
    mode: (row.mode as BackupMode) ?? "snapshot",
    storage: String(row.storage ?? ""),
    datastore: (row.datastore as string | null) ?? null,
    keepLast: row.keep_last === null || row.keep_last === undefined ? null : Number(row.keep_last),
    status: row.status as BackupStatus,
    upid: (row.upid as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    startedAt: row.started_at ? new Date(row.started_at as string) : null,
    finishedAt: row.finished_at ? new Date(row.finished_at as string) : null,
  };
}

export interface BackupScheduleInput {
  vmId: string;
  mode?: string;
  storage: string;
  datastore?: string | null;
  minute: number;
  hour: number;
  days?: string;
  keepLast?: number | null;
  createdBy?: string | null;
}

export function validateBackupScheduleInput(input: BackupScheduleInput): {
  mode: BackupMode;
  storage: string;
  datastore: string | null;
  minute: number;
  hour: number;
  days: string;
  keepLast: number | null;
} {
  const mode = (input.mode ?? "snapshot") as BackupMode;
  if (!BACKUP_MODES.includes(mode)) {
    throw AppError.validation(`mode must be one of: ${BACKUP_MODES.join(", ")}`);
  }
  if (typeof input.storage !== "string" || !STORAGE_PATTERN.test(input.storage)) {
    throw AppError.validation("storage must be a valid Proxmox storage ID (letters, digits, _ . -)");
  }
  let datastore: string | null = input.datastore ?? null;
  if (datastore !== null) {
    datastore = datastore.trim();
    if (!datastore || datastore.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(datastore)) {
      throw AppError.validation("datastore must be a valid PBS datastore name");
    }
  }
  if (!Number.isInteger(input.minute) || input.minute < 0 || input.minute > 59) {
    throw AppError.validation("minute must be 0-59");
  }
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) {
    throw AppError.validation("hour must be 0-23");
  }
  const days = input.days ?? "*";
  parseScheduleDays(days);
  let keepLast: number | null = input.keepLast ?? null;
  if (keepLast !== null) {
    if (!Number.isInteger(keepLast) || keepLast < 1 || keepLast > 365) {
      throw AppError.validation("keepLast must be 1-365 or omitted");
    }
  }
  return { mode, storage: input.storage, datastore, minute: input.minute, hour: input.hour, days, keepLast };
}

  // -- Schedules: validation, CRUD, due-queueing with re-auth ------------
export async function listBackupSchedules(db: Queryable, vmId?: string): Promise<BackupSchedule[]> {
  const result = vmId
    ? await db.query("SELECT * FROM pbs_backup_schedules WHERE vm_id = $1 ORDER BY hour ASC, minute ASC", [vmId])
    : await db.query("SELECT * FROM pbs_backup_schedules ORDER BY hour ASC, minute ASC");
  return result.rows.map((r) => toSchedule(r as Record<string, unknown>));
}

export async function getBackupSchedule(db: Queryable, id: string): Promise<BackupSchedule | null> {
  const result = await db.query("SELECT * FROM pbs_backup_schedules WHERE id = $1", [id]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? toSchedule(row) : null;
}

export async function createBackupSchedule(db: Queryable, input: BackupScheduleInput): Promise<BackupSchedule> {
  const v = validateBackupScheduleInput(input);
  const id = newId();
  await db.query(
    `INSERT INTO pbs_backup_schedules (id, vm_id, mode, storage, datastore, minute, hour, days, keep_last, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)`,
    [id, input.vmId, v.mode, v.storage, v.datastore, v.minute, v.hour, v.days, v.keepLast, input.createdBy ?? null],
  );
  const created = await getBackupSchedule(db, id);
  if (!created) throw new Error("Backup schedule creation failed");
  return created;
}

export async function deleteBackupSchedule(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query("DELETE FROM pbs_backup_schedules WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function setBackupScheduleEnabled(db: Queryable, id: string, enabled: boolean): Promise<void> {
  await db.query("UPDATE pbs_backup_schedules SET enabled = $2 WHERE id = $1", [id, enabled]);
}

  // -- Runs: capped creation, atomic claim, terminal transitions ---------
export async function listBackupRuns(
  db: Queryable,
  opts: { vmId?: string; limit?: number } = {},
): Promise<BackupRun[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const result = opts.vmId
    ? await db.query("SELECT * FROM pbs_backups WHERE vm_id = $1 ORDER BY created_at DESC LIMIT $2", [opts.vmId, limit])
    : await db.query("SELECT * FROM pbs_backups ORDER BY created_at DESC LIMIT $1", [limit]);
  return result.rows.map((r) => toRun(r as Record<string, unknown>));
}

export async function getBackupRun(db: Queryable, id: string): Promise<BackupRun | null> {
  const result = await db.query("SELECT * FROM pbs_backups WHERE id = $1", [id]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? toRun(row) : null;
}

export interface BackupRunInput {
  vmId: string;
  scheduleId?: string | null;
  kind?: BackupKind;
  mode?: BackupMode;
  storage?: string;
  datastore?: string | null;
  keepLast?: number | null;
  createdBy?: string | null;
}

export async function activeBackupRunCount(db: Queryable, vmId: string): Promise<number> {
  const result = await db.query<{ c: string }>(
    "SELECT COUNT(*)::text AS c FROM pbs_backups WHERE vm_id = $1 AND status IN ('PENDING', 'RUNNING')",
    [vmId],
  );
  return Number(result.rows[0]?.c ?? "0");
}

export async function createBackupRun(db: Queryable, input: BackupRunInput): Promise<BackupRun> {
  if ((await activeBackupRunCount(db, input.vmId)) >= MAX_ACTIVE_BACKUP_RUNS) {
    throw AppError.conflict(
      `Too many queued or running backups for this VM (max ${MAX_ACTIVE_BACKUP_RUNS}). Wait for one to finish.`,
    );
  }
  const id = newId();
  await db.query(
    `INSERT INTO pbs_backups (id, vm_id, schedule_id, kind, mode, storage, datastore, keep_last, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9)`,
    [
      id,
      input.vmId,
      input.scheduleId ?? null,
      input.kind ?? "backup",
      input.mode ?? "snapshot",
      input.storage ?? "",
      input.datastore ?? null,
      input.keepLast ?? null,
      input.createdBy ?? null,
    ],
  );
  const created = await getBackupRun(db, id);
  if (!created) throw new Error("Backup run creation failed");
  return created;
}

/** Atomically claim one PENDING run; null when already claimed/finished. */
export async function claimPendingBackupRun(db: Queryable, id: string): Promise<BackupRun | null> {
  const result = await db.query(
    "UPDATE pbs_backups SET status = 'RUNNING', started_at = NOW() WHERE id = $1 AND status = 'PENDING' RETURNING *",
    [id],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? toRun(row) : null;
}

export async function failBackupRun(db: Queryable, id: string, error: string): Promise<void> {
  await db.query("UPDATE pbs_backups SET status = 'FAILED', error = $2, finished_at = NOW() WHERE id = $1", [id, error]);
}

/** Marks a run done; only called after the task reports terminal OK. */
export async function completeBackupRun(db: Queryable, id: string): Promise<void> {
  await db.query("UPDATE pbs_backups SET status = 'OK', finished_at = NOW() WHERE id = $1", [id]);
}

export interface BackupTickerDeps {
  db: Queryable;
  vms: Pick<VmsRepository, "requireById">;
  users: Pick<UsersService, "findById">;
  settings: Pick<SettingsService, "getPlain">;
  getProxmoxClient: () => Promise<ProxmoxClient>;
  getPbsClient: () => Promise<ProxmoxBackupClient | null>;
  audit: Pick<AuditService, "record">;
  logger: Logger;
}

async function actorUsername(deps: BackupTickerDeps, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    return (await deps.users.findById(userId))?.username ?? null;
  } catch {
    return null;
  }
}

/**
 * Creator re-authorization (worker re-auth pattern): a schedule must not
 * keep firing after its owner lost access. System rows (no creator) and
 * revoked creators are skipped with an audit trail instead of running.
 */
async function creatorMayRunBackups(deps: BackupTickerDeps, creatorId: string | null): Promise<boolean> {
  if (!creatorId) return false;
  const creator = await deps.users.findById(creatorId).catch(() => null);
  if (!creator || !creator.active) return false;
  if (hasPermission(creator, "vm.manage")) return true;
  const effective = await resolveEffectiveAccess(deps.db, creatorId);
  return effective.permissions.has("vm.manage");
}

/** Fire every due schedule once by queueing a PENDING run (never executes inline). */
export async function runDueBackupSchedules(
  deps: BackupTickerDeps,
  now = new Date(),
): Promise<{ queued: number; skipped: number }> {
  let queued = 0;
  let skipped = 0;
  const schedules = await listBackupSchedules(deps.db);
  for (const schedule of schedules) {
    if (!scheduleDueNow(schedule, now)) continue;
    await deps.db.query("UPDATE pbs_backup_schedules SET last_run_at = NOW() WHERE id = $1", [schedule.id]);
    if (!(await creatorMayRunBackups(deps, schedule.createdBy))) {
      skipped += 1;
      await deps.audit
        .record({
          event: "BACKUP_SKIPPED",
          actorUserId: schedule.createdBy,
          actorUsername: await actorUsername(deps, schedule.createdBy),
          vmId: schedule.vmId,
          detail: { scheduleId: schedule.id, reason: "creator no longer authorized" },
        })
        .catch(() => undefined);
      continue;
    }
    // No pile-up: skip when this schedule already has a queued/active run.
    const busy = await deps.db.query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM pbs_backups WHERE schedule_id = $1 AND status IN ('PENDING', 'RUNNING')",
      [schedule.id],
    );
    if (Number(busy.rows[0]?.c ?? "0") > 0) {
      skipped += 1;
      continue;
    }
    try {
      await createBackupRun(deps.db, {
        vmId: schedule.vmId,
        scheduleId: schedule.id,
        kind: "backup",
        mode: schedule.mode,
        storage: schedule.storage,
        datastore: schedule.datastore,
        keepLast: schedule.keepLast,
        createdBy: schedule.createdBy,
      });
      queued += 1;
    } catch (err) {
      skipped += 1;
      deps.logger.warn(
        { scheduleId: schedule.id, error: err instanceof Error ? err.message : String(err) },
        "scheduled backup could not be queued",
      );
    }
  }
  return { queued, skipped };
}

/** Start every PENDING run (vzdump/prune task creation only — never waits). */
export async function executePendingBackups(deps: BackupTickerDeps): Promise<{ started: number; failed: number }> {
  let started = 0;
  let failed = 0;
  const pending = await deps.db.query("SELECT id FROM pbs_backups WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 20");
  for (const row of pending.rows as Array<{ id: string }>) {
    const run = await claimPendingBackupRun(deps.db, row.id);
    if (!run) continue;
    try {
      if (!(await creatorMayRunBackups(deps, run.createdBy))) {
        throw AppError.forbidden("creator no longer authorized to run backups");
      }
      const vm = await deps.vms.requireById(run.vmId);
      if (run.kind === "prune") {
        const pbs = await deps.getPbsClient();
        if (!pbs) throw AppError.external("PBS", "Proxmox Backup Server is not configured");
        const datastore = run.datastore ?? (await deps.settings.getPlain("pbs.datastore"));
        if (!datastore) throw AppError.validation("No PBS datastore configured for this prune");
        if (run.keepLast === null) throw AppError.validation("Prune requires keepLast");
        // Resolve the real group id first: PBS reports bare numeric ids
        // ("136"), not "vm/136". Pruning an unmatched id would either fail
        // opaquely or — worse — succeed against the wrong group.
        const backupId = resolveVmBackupId(await pbs.listBackupGroups(datastore), vm.vmid);
        if (!backupId) throw AppError.validation("No snapshots found for this VM — nothing to prune");
        const upid = await pbs.pruneSnapshots(datastore, { backupId, keepLast: run.keepLast });
        await deps.db.query("UPDATE pbs_backups SET upid = $2 WHERE id = $1", [run.id, upid]);
      } else {
        const proxmox = await deps.getProxmoxClient();
        const upid = await proxmox.createBackup(vm.node, { vmid: vm.vmid, storage: run.storage, mode: run.mode });
        if (!upid) throw AppError.external("Proxmox", "Backup task did not return a UPID");
        await deps.db.query("UPDATE pbs_backups SET upid = $2 WHERE id = $1", [run.id, upid]);
      }
      started += 1;
      await deps.audit
        .record({
          event: "BACKUP_STARTED",
          actorUserId: run.createdBy,
          actorUsername: await actorUsername(deps, run.createdBy),
          vmId: run.vmId,
          detail: {
            runId: run.id,
            scheduleId: run.scheduleId,
            kind: run.kind,
            mode: run.kind === "backup" ? run.mode : undefined,
          },
        })
        .catch(() => undefined);
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await failBackupRun(deps.db, run.id, message);
      deps.logger.warn({ runId: run.id, error: message }, "backup run failed to start");
      await deps.audit
        .record({
          event: "BACKUP_FINISHED",
          actorUserId: run.createdBy,
          actorUsername: await actorUsername(deps, run.createdBy),
          vmId: run.vmId,
          detail: { runId: run.id, scheduleId: run.scheduleId, kind: run.kind, result: "failed", error: message },
        })
        .catch(() => undefined);
    }
  }
  return { started, failed };
}

/** Poll every RUNNING run once; finalize terminal ones, chain retention prunes. */
export async function finalizeBackupRuns(deps: BackupTickerDeps): Promise<{ finished: number; failed: number }> {
  let finished = 0;
  let failed = 0;
  const running = await deps.db.query("SELECT * FROM pbs_backups WHERE status = 'RUNNING' ORDER BY started_at ASC NULLS FIRST LIMIT 20");
  for (const row of running.rows as Record<string, unknown>[]) {
    const run = toRun(row);
    try {
      if (!run.upid) throw new Error("Backup task has no UPID");
      let terminal = false;
      let ok = false;
      let statusDetail = "";
      if (run.kind === "prune") {
        const pbs = await deps.getPbsClient();
        if (!pbs) throw AppError.external("PBS", "Proxmox Backup Server is not configured");
        const st = await pbs.pbsTaskStatus(run.upid);
        if (st.status === "stopped") {
          terminal = true;
          ok = !st.exitstatus || st.exitstatus === "OK";
          statusDetail = st.exitstatus ?? "OK";
        }
      } else {
        const vm = await deps.vms.requireById(run.vmId);
        const proxmox = await deps.getProxmoxClient();
        const st = await proxmox.taskStatus(vm.node, run.upid);
        if (st.status === "stopped") {
          terminal = true;
          ok = !st.exitstatus || st.exitstatus === "OK";
          statusDetail = st.exitstatus ?? "OK";
        }
      }
      if (!terminal) continue;
      if (ok) {
        await completeBackupRun(deps.db, run.id);
        finished += 1;
        await deps.audit
          .record({
            event: run.kind === "prune" ? "BACKUP_PRUNED" : "BACKUP_FINISHED",
            actorUserId: run.createdBy,
            actorUsername: await actorUsername(deps, run.createdBy),
            vmId: run.vmId,
            detail: { runId: run.id, scheduleId: run.scheduleId, kind: run.kind, result: "ok", status: statusDetail },
          })
          .catch(() => undefined);
        // Retention: chain a prune run after a successful backup when the
        // schedule (or manual trigger) asked to keep only N snapshots.
        if (run.kind === "backup" && run.keepLast !== null) {
          await createBackupRun(deps.db, {
            vmId: run.vmId,
            scheduleId: run.scheduleId,
            kind: "prune",
            mode: run.mode,
            storage: run.storage,
            datastore: run.datastore,
            keepLast: run.keepLast,
            createdBy: run.createdBy,
          }).catch((err) =>
            deps.logger.warn(
              { runId: run.id, error: err instanceof Error ? err.message : String(err) },
              "retention prune could not be queued",
            ),
          );
        }
      } else {
        throw new Error(`Task ended with status: ${statusDetail || "unknown"}`);
      }
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await failBackupRun(deps.db, run.id, message);
      await deps.audit
        .record({
          event: "BACKUP_FINISHED",
          actorUserId: run.createdBy,
          actorUsername: await actorUsername(deps, run.createdBy),
          vmId: run.vmId,
          detail: { runId: run.id, scheduleId: run.scheduleId, kind: run.kind, result: "failed", error: message },
        })
        .catch(() => undefined);
      // Failed backups page admins and the owner: silent backup rot is how
      // data loss happens. Best-effort — the FAILED row is the record.
      try {
        const audiences =
          run.createdBy && run.createdBy !== ADMIN_AUDIENCE ? [ADMIN_AUDIENCE, run.createdBy] : [ADMIN_AUDIENCE];
        await notify(
          deps.db,
          audiences,
          {
            kind: "backup",
            title: `Backup ${run.kind} failed`,
            body: message.slice(0, 300),
            link: "/backups",
          },
        );
      } catch {
        // notification must never break the ticker loop
      }
      // Same failure to Gotify (admin push): best-effort, never breaks loop.
      try {
        await sendGotifyMessage(deps.settings, {
          title: `Backup ${run.kind} failed`,
          message: message.slice(0, 300),
          priority: 8,
        });
      } catch {
        // delivery must never break the ticker loop
      }
    }
  }
  return { finished, failed };
}

/** One minute-tick pass: queue due schedules, start pending runs, finalize running ones. */
export async function runBackupPass(
  deps: BackupTickerDeps,
  now = new Date(),
): Promise<{ queued: number; started: number; finished: number; failed: number }> {
  const due = await runDueBackupSchedules(deps, now).catch((err) => {
    deps.logger.warn({ error: err instanceof Error ? err.message : String(err) }, "backup due pass failed");
    return { queued: 0, skipped: 0 };
  });
  const exec = await executePendingBackups(deps).catch((err) => {
    deps.logger.warn({ error: err instanceof Error ? err.message : String(err) }, "backup execute pass failed");
    return { started: 0, failed: 0 };
  });
  const fin = await finalizeBackupRuns(deps).catch((err) => {
    deps.logger.warn({ error: err instanceof Error ? err.message : String(err) }, "backup finalize pass failed");
    return { finished: 0, failed: 0 };
  });
  return { queued: due.queued, started: exec.started, finished: fin.finished, failed: exec.failed + fin.failed };
}

export interface BackupSnapshot {
  backupId: string;
  backupType: string | null;
  backupCount: number | null;
  lastBackup: string | null;
}

export interface VmSnapshotMatch {
  count: number;
  lastBackup: string | null;
}

/**
 * Live PBS servers report VM snapshot groups with a BARE numeric backup-id
 * (e.g. `"backup-id": "136"`, verified against PBS 4.2) — not the
 * `"vm/136"` form older docs and fixtures suggest. Both forms must match,
 * or snapshots stay invisible and prunes address a group that does not
 * exist. The bare form only counts when backup-type is "vm" (or absent),
 * so a container/host group that happens to share the number never
 * collides with a VM.
 */
export function groupBelongsToVm(rec: Record<string, unknown>, vmid: number): boolean {
  const id = rec["backup-id"];
  if (id === `vm/${vmid}`) return true;
  if (id === String(vmid)) {
    const type = rec["backup-type"];
    return type === undefined || type === "vm";
  }
  return false;
}

/** The backup-id string to address PBS with for this VM (prefixed form
 *  preferred when both exist), or null when the VM has no snapshots. */
export function resolveVmBackupId(groups: unknown[], vmid: number): string | null {
  let bare: string | null = null;
  for (const g of groups) {
    if (typeof g !== "object" || g === null) continue;
    const rec = g as Record<string, unknown>;
    if (rec["backup-id"] === `vm/${vmid}`) return `vm/${vmid}`;
    if (bare === null && groupBelongsToVm(rec, vmid) && typeof rec["backup-id"] === "string") {
      bare = rec["backup-id"] as string;
    }
  }
  return bare;
}

/**
 * Pure matcher: fold raw PBS group rows into per-VM snapshot summaries.
 * Unknown shapes are skipped; no group content (files, paths, secrets)
 * survives — only counts and timestamps come out.
 */
export function matchSnapshotsToVms(
  groups: unknown[],
  vms: Array<{ id: string; vmid: number }>,
): Map<string, VmSnapshotMatch> {
  const byBackupId = new Map<string, { count: number; lastBackup: string | null; backupType: unknown }>();
  for (const g of groups.slice(0, 500)) {
    if (typeof g !== "object" || g === null) continue;
    const rec = g as Record<string, unknown>;
    if (typeof rec["backup-id"] !== "string") continue;
    const last = rec["last-backup"];
    const entry = byBackupId.get(rec["backup-id"] as string) ?? { count: 0, lastBackup: null, backupType: rec["backup-type"] };
    entry.count += typeof rec["backup-count"] === "number" ? (rec["backup-count"] as number) : 1;
    const stamp =
      typeof last === "number"
        ? new Date(last * 1000).toISOString()
        : typeof last === "string"
          ? last
          : null;
    if (stamp && (!entry.lastBackup || stamp > entry.lastBackup)) entry.lastBackup = stamp;
    byBackupId.set(rec["backup-id"] as string, entry);
  }
  const out = new Map<string, VmSnapshotMatch>();
  for (const vm of vms) {
    // Either id form counts (see groupBelongsToVm): the prefixed form, plus
    // the bare numeric id when its group is vm-typed (or untyped).
    const direct = byBackupId.get(`vm/${vm.vmid}`);
    const bare = byBackupId.get(String(vm.vmid));
    const bareUsable = bare && (bare.backupType === undefined || bare.backupType === "vm");
    const count = (direct?.count ?? 0) + (bareUsable ? bare.count : 0);
    const lastBackup = [direct?.lastBackup, bareUsable ? bare.lastBackup : null]
      .filter((s): s is string => !!s)
      .sort()
      .pop() ?? null;
    if (direct || bareUsable) out.set(vm.id, { count, lastBackup });
  }
  return out;
}

export interface BackupOverviewRow {
  vmId: string;
  name: string;
  vmid: number;
  node: string;
  schedules: number;
  enabledSchedules: number;
  lastRun: { status: BackupStatus; kind: BackupKind; createdAt: string } | null;
  lastSnapshot: string | null;
  snapshotCount: number | null;
}

/**
 * Fleet overview for the backup page: one row per VM with schedule
 * coverage, latest run, and latest PBS snapshot. Snapshot lookup is a
 * single PBS groups call matched locally; any PBS failure degrades to
 * null snapshots instead of failing the whole overview.
 */
export async function getBackupOverview(
  deps: Pick<BackupTickerDeps, "db" | "settings" | "getPbsClient">,
  vms: Array<{ id: string; name: string; vmid: number; node: string }>,
): Promise<BackupOverviewRow[]> {
  const schedules = await listBackupSchedules(deps.db);
  const runs = await listBackupRuns(deps.db, { limit: 200 });
  let matches = new Map<string, VmSnapshotMatch>();
  try {
    const pbs = await deps.getPbsClient();
    const store = await deps.settings.getPlain("pbs.datastore");
    if (pbs && store) {
      matches = matchSnapshotsToVms(await pbs.listBackupGroups(store), vms);
    }
  } catch {
    matches = new Map();
  }
  return vms.map((vm) => {
    const mine = schedules.filter((s) => s.vmId === vm.id);
    const lastRun = runs.find((r) => r.vmId === vm.id) ?? null;
    const snap = matches.get(vm.id);
    return {
      vmId: vm.id,
      name: vm.name,
      vmid: vm.vmid,
      node: vm.node,
      schedules: mine.length,
      enabledSchedules: mine.filter((s) => s.enabled).length,
      lastRun: lastRun
        ? { status: lastRun.status, kind: lastRun.kind, createdAt: lastRun.createdAt.toISOString() }
        : null,
      lastSnapshot: snap?.lastBackup ?? null,
      snapshotCount: snap ? snap.count : null,
    };
  });
}

/** Snapshots for one VM, projected to safe scalars (no credentials, no paths). */
export async function listVmSnapshots(
  deps: Pick<BackupTickerDeps, "db" | "vms" | "settings" | "getPbsClient">,
  vmId: string,
  datastore?: string | null,
): Promise<BackupSnapshot[]> {
  const vm = await deps.vms.requireById(vmId);
  const pbs = await deps.getPbsClient();
  if (!pbs) throw AppError.external("PBS", "Proxmox Backup Server is not configured");
  const store = datastore ?? (await deps.settings.getPlain("pbs.datastore"));
  if (!store) throw AppError.validation("No PBS datastore configured");
  const groups = await pbs.listBackupGroups(store);
  const out: BackupSnapshot[] = [];
  for (const g of groups.slice(0, 200)) {
    if (typeof g !== "object" || g === null) continue;
    const rec = g as Record<string, unknown>;
    if (!groupBelongsToVm(rec, vm.vmid)) continue;
    const last = rec["last-backup"];
    out.push({
      backupId: String(rec["backup-id"]),
      backupType: typeof rec["backup-type"] === "string" ? (rec["backup-type"] as string) : null,
      backupCount: typeof rec["backup-count"] === "number" ? (rec["backup-count"] as number) : null,
      lastBackup:
        typeof last === "number"
          ? new Date(last * 1000).toISOString()
          : typeof last === "string"
            ? last
            : null,
    });
  }
  return out;
}
