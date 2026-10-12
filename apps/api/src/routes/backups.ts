// ---------------------------------------------------------------------------
// Backups routes: fleet overview, PBS schedules (CRUD + bulk), manual run /
//   prune triggers (single + bulk), run history, snapshot listing.
// Permissions: writes need vm.manage + per-VM visibility; history/snapshots
//   need vm.read + visibility; ADMINs see all, others only granted VMs.
// Rate limits: single run/prune 10/hr, bulk run 5/hr (vzdump is expensive;
//   202-accepted async runs are picked up by the minute ticker).
// Security: PBS must be configured or every mutating path 503s; triggers
//   never block on vzdump; bulk paths return per-VM results + summary audit.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import {
  AppError,
  BACKUP_MODES,
  createBackupRun,
  createBackupSchedule,
  deleteBackupSchedule,
  getBackupSchedule,
  getBackupOverview,
  listBackupRuns,
  listBackupSchedules,
  listVmSnapshots,
  setBackupScheduleEnabled,
} from "@proxvm/core";

// PBS backup schedules, manual runs, run history, snapshots, and retention
// pruning. Reads need vm.read + VM visibility; anything that creates,
// mutates, or spends resources needs vm.manage. All executions are
// asynchronous (PENDING runs picked up by the minute ticker); triggers
// return 202 immediately and never block on vzdump.
/**
 * Register PBS backup scheduling/execution/history endpoints.
 * WHY async triggers: vzdump runs for minutes, so POST only queues a PENDING
 * run and returns 202; the ticker executes, keeping HTTP workers free.
 */
export async function backupRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;
  const manageGuard = app.requirePermission("vm.manage");
  const readGuard = app.requirePermission("vm.read");

  const resolveVmAccess = async (request: Parameters<typeof app.requireAuth>[0], vmId: string) => {
    const user = await app.requireAuth(request);
    const { allowed } = await ctx.vms.visibleTo(user.id, user.roles, vmId);
    return { user, allowed };
  };

  const requirePbs = async () => {
    const client = await ctx.getPbsClient();
    if (!client) {
      throw new AppError("CONFIGURATION_ERROR", "Proxmox Backup Server is not configured. Complete setup in Settings.", 503);
    }
    return client;
  };

  const defaultDatastore = async (): Promise<string | null> => ctx.settings.getPlain("pbs.datastore");

  // -- Fleet overview (one row per visible VM) --------------------------------
  app.get("/backups/overview", async (request) => {
    const user = await manageGuard(request);
    const all = await ctx.vms.list();
    const vms = [];
    for (const vm of all) {
      if (user.roles.includes("ADMIN")) {
        vms.push(vm);
        continue;
      }
      const access = await resolveVmAccess(request, vm.id);
      if (access.allowed) vms.push(vm);
    }
    return {
      overview: await getBackupOverview(
        { db: ctx.db, settings: ctx.settings, getPbsClient: () => ctx.getPbsClient() },
        vms.map((vm) => ({ id: vm.id, name: vm.name, vmid: vm.vmid, node: vm.node })),
      ),
    };
  });

  // -- Schedules ------------------------------------------------------------
  app.get("/backups/schedules", async (request) => {
    const user = await manageGuard(request);
    const schedules = await listBackupSchedules(ctx.db);
    if (user.roles.includes("ADMIN")) return { schedules };
    const visible = [];
    for (const schedule of schedules) {
      const access = await resolveVmAccess(request, schedule.vmId);
      if (access.allowed) visible.push(schedule);
    }
    return { schedules: visible };
  });

  app.post("/backups/schedules", async (request) => {
    const user = await manageGuard(request);
    const body = z
      .object({
        vmId: z.string().uuid(),
        mode: z.enum(BACKUP_MODES).optional(),
        storage: z.string().min(1).max(128),
        datastore: z.string().min(1).max(128).optional(),
        hour: z.number().int().min(0).max(23),
        minute: z.number().int().min(0).max(59),
        days: z.string().max(32).optional(),
        keepLast: z.number().int().min(1).max(365).nullable().optional(),
      })
      .parse(request.body);
    const access = await resolveVmAccess(request, body.vmId);
    if (!access.allowed) throw AppError.forbidden("No access to this VM");
    await ctx.vms.requireById(body.vmId);
    await requirePbs();
    const schedule = await createBackupSchedule(ctx.db, { ...body, createdBy: user.id });
    await app.audit(request, {
      event: "BACKUP_SCHEDULE_CREATED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: body.vmId,
      detail: {
        scheduleId: schedule.id,
        mode: schedule.mode,
        storage: schedule.storage,
        hour: schedule.hour,
        minute: schedule.minute,
        days: schedule.days,
        keepLast: schedule.keepLast,
      },
    });
    return { schedule };
  });

  app.delete("/backups/schedules/:id", async (request, reply) => {
    const user = await manageGuard(request);
    const { id } = request.params as { id: string };
    const schedule = await getBackupSchedule(ctx.db, id);
    if (!schedule) return reply.status(404).send({ code: "NOT_FOUND", message: "Backup schedule not found" });
    const access = await resolveVmAccess(request, schedule.vmId);
    if (!access.allowed) throw AppError.forbidden("No access to this VM");
    await deleteBackupSchedule(ctx.db, id);
    await app.audit(request, {
      event: "BACKUP_SCHEDULE_DELETED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: schedule.vmId,
      detail: { scheduleId: id },
    });
    return { ok: true };
  });

  app.patch("/backups/schedules/:id", async (request, reply) => {
    const user = await manageGuard(request);
    const { id } = request.params as { id: string };
    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    const schedule = await getBackupSchedule(ctx.db, id);
    if (!schedule) return reply.status(404).send({ code: "NOT_FOUND", message: "Backup schedule not found" });
    const access = await resolveVmAccess(request, schedule.vmId);
    if (!access.allowed) throw AppError.forbidden("No access to this VM");
    await setBackupScheduleEnabled(ctx.db, id, body.enabled);
    await app.audit(request, {
      event: "BACKUP_SCHEDULE_UPDATED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: schedule.vmId,
      detail: { scheduleId: id, enabled: body.enabled },
    });
    return { ok: true };
  });

  // -- Bulk schedule creation (same timetable across many VMs) ---------------
  // Per-VM results: one bad VM never aborts the rest. A single summary
  // audit covers the batch; each row still records its creator.
  app.post("/backups/schedules/bulk", async (request, reply) => {
    const user = await manageGuard(request);
    const body = z
      .object({
        vmIds: z.array(z.string().uuid()).min(1).max(50),
        mode: z.enum(BACKUP_MODES).optional(),
        storage: z.string().min(1).max(128),
        datastore: z.string().min(1).max(128).optional(),
        hour: z.number().int().min(0).max(23),
        minute: z.number().int().min(0).max(59),
        days: z.string().max(32).optional(),
        keepLast: z.number().int().min(1).max(365).nullable().optional(),
      })
      .parse(request.body);
    await requirePbs();
    const created: Array<{ vmId: string; scheduleId: string }> = [];
    const failed: Array<{ vmId: string; error: string }> = [];
    for (const vmId of [...new Set(body.vmIds)]) {
      try {
        const access = await resolveVmAccess(request, vmId);
        if (!access.allowed) throw AppError.forbidden("No access to this VM");
        await ctx.vms.requireById(vmId);
        const schedule = await createBackupSchedule(ctx.db, {
          vmId,
          mode: body.mode,
          storage: body.storage,
          datastore: body.datastore,
          hour: body.hour,
          minute: body.minute,
          days: body.days,
          keepLast: body.keepLast,
          createdBy: user.id,
        });
        created.push({ vmId, scheduleId: schedule.id });
      } catch (err) {
        failed.push({ vmId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await app.audit(request, {
      event: "BACKUP_SCHEDULE_CREATED",
      actorUserId: user.id,
      actorUsername: user.username,
      detail: {
        bulk: true,
        mode: body.mode ?? "snapshot",
        storage: body.storage,
        hour: body.hour,
        minute: body.minute,
        created: created.length,
        failed: failed.length,
        vmIds: created.map((c) => c.vmId),
      },
    });
    return reply.status(202).send({ created, failed });
  });

  // -- Bulk trigger (queue one run per VM, async like the single path) ------
  app.post(
    "/backups/run-bulk",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const user = await manageGuard(request);
      const body = z
        .object({
          vmIds: z.array(z.string().uuid()).min(1).max(50),
          mode: z.enum(BACKUP_MODES).optional(),
          storage: z.string().min(1).max(128),
          datastore: z.string().min(1).max(128).optional(),
          keepLast: z.number().int().min(1).max(365).nullable().optional(),
        })
        .parse(request.body);
      await requirePbs();
      const queued: Array<{ vmId: string; runId: string }> = [];
      const failed: Array<{ vmId: string; error: string }> = [];
      for (const vmId of [...new Set(body.vmIds)]) {
        try {
          const access = await resolveVmAccess(request, vmId);
          if (!access.allowed) throw AppError.forbidden("No access to this VM");
          const vm = await ctx.vms.requireById(vmId);
          const run = await createBackupRun(ctx.db, {
            vmId: vm.id,
            kind: "backup",
            mode: body.mode ?? "snapshot",
            storage: body.storage,
            datastore: body.datastore ?? (await defaultDatastore()),
            keepLast: body.keepLast ?? null,
            createdBy: user.id,
          });
          queued.push({ vmId, runId: run.id });
        } catch (err) {
          failed.push({ vmId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      await app.audit(request, {
        event: "BACKUP_STARTED",
        actorUserId: user.id,
        actorUsername: user.username,
        detail: { bulk: true, mode: body.mode ?? "snapshot", queued: queued.length, failed: failed.length },
      });
      return reply.status(202).send({ queued, failed });
    },
  );

  // -- Manual trigger (async: queues a PENDING run, ticker executes) --------
  app.post(
    "/vms/:id/backups/run",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = await manageGuard(request);
      const access = await resolveVmAccess(request, id);
      if (!access.allowed) throw AppError.forbidden("No access to this VM");
      const vm = await ctx.vms.requireById(id);
      await requirePbs();
      const body = z
        .object({
          mode: z.enum(BACKUP_MODES).optional(),
          storage: z.string().min(1).max(128),
          datastore: z.string().min(1).max(128).optional(),
          keepLast: z.number().int().min(1).max(365).nullable().optional(),
        })
        .parse(request.body ?? {});
      const run = await createBackupRun(ctx.db, {
        vmId: vm.id,
        kind: "backup",
        mode: body.mode ?? "snapshot",
        storage: body.storage,
        datastore: body.datastore ?? (await defaultDatastore()),
        keepLast: body.keepLast ?? null,
        createdBy: user.id,
      });
      await app.audit(request, {
        event: "BACKUP_STARTED",
        actorUserId: user.id,
        actorUsername: user.username,
        vmId: vm.id,
        detail: { runId: run.id, kind: "backup", mode: run.mode, queued: true },
      });
      return reply.status(202).send({ run });
    },
  );

  // -- Manual retention prune (async, same run machinery) --------------------
  app.post(
    "/vms/:id/backups/prune",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = await manageGuard(request);
      const access = await resolveVmAccess(request, id);
      if (!access.allowed) throw AppError.forbidden("No access to this VM");
      const vm = await ctx.vms.requireById(id);
      await requirePbs();
      const body = z
        .object({
          datastore: z.string().min(1).max(128).optional(),
          keepLast: z.number().int().min(1).max(365),
        })
        .parse(request.body ?? {});
      const run = await createBackupRun(ctx.db, {
        vmId: vm.id,
        kind: "prune",
        mode: "snapshot",
        storage: "",
        datastore: body.datastore ?? (await defaultDatastore()),
        keepLast: body.keepLast,
        createdBy: user.id,
      });
      await app.audit(request, {
        event: "BACKUP_STARTED",
        actorUserId: user.id,
        actorUsername: user.username,
        vmId: vm.id,
        detail: { runId: run.id, kind: "prune", keepLast: body.keepLast, queued: true },
      });
      return reply.status(202).send({ run });
    },
  );

  // -- History + snapshots (read-only) ---------------------------------------
  app.get("/vms/:id/backups/runs", async (request) => {
    const { id } = request.params as { id: string };
    await readGuard(request);
    const access = await resolveVmAccess(request, id);
    if (!access.allowed) throw AppError.forbidden("No access to this VM");
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    return { runs: await listBackupRuns(ctx.db, { vmId: id, limit: query.limit }) };
  });

  app.get("/vms/:id/backups/snapshots", async (request) => {
    const { id } = request.params as { id: string };
    await readGuard(request);
    const access = await resolveVmAccess(request, id);
    if (!access.allowed) throw AppError.forbidden("No access to this VM");
    const query = z.object({ datastore: z.string().min(1).max(128).optional() }).parse(request.query);
    return {
      snapshots: await listVmSnapshots(
        { db: ctx.db, vms: ctx.vms, settings: ctx.settings, getPbsClient: () => ctx.getPbsClient() },
        id,
        query.datastore ?? (await defaultDatastore()),
      ),
    };
  });
}
