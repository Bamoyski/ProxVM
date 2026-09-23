import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import {
  AppError,
  isAdmin,
  createSchedule,
  createShareLink,
  deleteSchedule,
  enqueueProvisioningJob,
  getShareLink,
  listSchedules,
  listShareLinks,
  listVmServices,
  redeemShareLink,
  revokeShareLink,
  reconcileUserVmGuacAccess,
  resolveProvisionDefaults,
  resolveProvisionRequest,
  scanVmServices,
  selectUsableIpv4,
  setScheduleEnabled,
  storeVmServices,
  toPublicUser,
  type EnqueueJobData,
} from "@proxvm/core";
import { basicProvisionSchema } from "@proxvm/shared";
import type { Queue } from "bullmq";

const ipOverrideSchema = z.object({ ip: z.string().ip({ version: "v4" }) });
const actionBody = z.object({ force: z.boolean().optional() });
const deleteBody = z.object({ confirmText: z.string().min(1) });

export async function vmRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  const getQueue = (): Queue<EnqueueJobData> => {
    const queue = (app as unknown as { queue?: Queue<EnqueueJobData> }).queue;
    if (!queue) {
      throw new AppError("CONFIGURATION_ERROR", "Provisioning queue is not available (Redis disconnected?)", 503);
    }
    return queue;
  };

  // Flag-aware: delegates to the shared helper so the privacy bypass-removal
  // applies to every endpoint below uniformly.
  const resolveVmAccess = async (request: Parameters<typeof app.requireAuth>[0], vmId: string) => {
    const user = await app.requireAuth(request);
    const { allowed } = await ctx.vms.visibleTo(user.id, user.roles, vmId);
    return { user, allowed };
  };

  app.post("/vms/provision", async (request, reply) => {
    const actor = await app.requirePermission("vm.create")(request);
    // Accept both full (Advanced) and partial (Basic) requests. Partial
    // requests are resolved to a full, schema-validated provisioning request
    // through the centralized defaults resolver; the pipeline below is
    // identical for both modes.
    const input = basicProvisionSchema.parse(request.body);
    if (!input.templateId) {
      throw AppError.validation("templateId is required. Register the template first on the Templates page.");
    }
    const body = await resolveProvisionRequest(
      { settings: ctx.settings, templates: ctx.templates, users: ctx.users },
      input,
    );
    if (body.assignToUserIds.length) {
      // DB-aware check (custom roles included), consistent with the access
      // management endpoints. The resolver already validated existence.
      await app.requirePermission("vm.edit")(request);
    }
    const template = await ctx.templates.requireById(body.templateId as string);
    const duplicate = await ctx.jobs.activeJobWithName(actor.id, body.name);
    if (duplicate) {
      throw AppError.conflict(
        `You already have an active provisioning job for "${body.name}" (job ${duplicate.id.slice(0, 8)}, status ${duplicate.status}). Wait for it to finish or cancel it before submitting again.`,
      );
    }
    const request2 = { ...body, password: ctx.encrypt(body.password) };
    const job = await ctx.jobs.create({
      vmId: null,
      request: request2 as unknown as Record<string, unknown>,
      createdByUserId: actor.id,
    });
    try {
      await enqueueProvisioningJob(getQueue(), ctx.jobs, job.id, { attempt: 0 });
    } catch (err) {
      // The queue (Redis) is down: never leave the job row PENDING forever.
      // Mark it FAILED with the enqueue error so the UI/API report terminal
      // state and a later retry starts clean.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await ctx.jobs.updateStatus(job.id, "FAILED", message);
        await ctx.audit.record({
          event: "PROVISIONING_FAILED",
          actorUserId: actor.id,
          actorUsername: actor.username,
          jobId: job.id,
          detail: { error: message, attempt: 0, during: "enqueue" },
        });
      } catch {
        // Compensation must never mask the original enqueue error.
      }
      throw err;
    }
    await ctx.audit.record({
      event: "PROVISIONING_STARTED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      jobId: job.id,
      detail: { name: body.name, template: template.name, node: body.node, storage: body.storage },
    });
    return reply.status(202).send({ jobId: job.id });
  });

  app.get("/provisioning/defaults", async (request) => {
    await app.requirePermission("vm.create")(request);
    const query = z
      .object({ templateId: z.string().uuid().optional(), node: z.string().max(128).optional() })
      .parse(request.query);
    return resolveProvisionDefaults(
      {
        settings: ctx.settings,
        templates: ctx.templates,
        users: ctx.users,
        getProxmoxClient: () => ctx.getProxmoxClient(),
      },
      query,
    );
  });

  app.get("/vms", async (request) => {
    const user = await app.requireAuth(request);
    const privileged = user.roles.some((r) => r === "ADMIN" || r === "OPERATOR");
    let dbVms = privileged ? await ctx.vms.list() : await ctx.vms.listAssignedToUser(user.id);
    if (privileged) {
      // Privacy-flagged VMs are invisible without a concrete grant, even here.
      const visible = [];
      for (const vm of dbVms) {
        if (!vm.privacyFlag || (await ctx.vms.hasAccessOrOwns(vm.id, user.id))) visible.push(vm);
      }
      dbVms = visible;
    }

    let resources: Array<Record<string, unknown>> = [];
    let proxmoxConnected = true;
    let proxmoxError: string | null = null;
    try {
      const client = await ctx.getProxmoxClient();
      resources = (await client.clusterResources()) as unknown as Array<Record<string, unknown>>;
    } catch (err) {
      proxmoxConnected = false;
      proxmoxError = err instanceof Error ? err.message : String(err);
    }

    const items = [];
    for (const vm of dbVms) {
      const res = resources.find(
        (r) => Number(r.vmid) === vm.vmid && String(r.node) === vm.node && Number(r.template ?? 0) !== 1,
      );
      const guac = await ctx.guac.findConnectionRecord(vm.id);
      const cred = await ctx.creds.findByVm(vm.id);
      items.push({
        id: vm.id,
        vmid: vm.vmid,
        node: vm.node,
        name: res?.name !== undefined && res.name !== "" ? String(res.name) : vm.name,
        tracked: true,
        private: vm.privacyFlag,
        status: res ? String(res.status ?? "unknown") : vm.status,
        osType: vm.osType,
        osName: vm.osName,
        os: vm.osName ?? friendlyOsType(vm.osType),
        ip: vm.ipAddress,
        cpu: res ? { used: res.cpu ?? null, max: Number(res.maxcpu ?? 0) } : null,
        mem: res ? { used: res.mem ?? null, max: Number(res.maxmem ?? 0) } : null,
        disk: res ? { used: res.disk ?? null, max: Number(res.maxdisk ?? 0) } : null,
        uptime: res?.uptime != null ? Number(res.uptime) : null,
        guacamole: guac
          ? { created: true, status: guac.status, protocol: guac.protocol, port: guac.port }
          : { created: false, status: null, protocol: null, port: null },
        credentialStatus: cred?.status ?? null,
        templateId: vm.templateId ?? null,
      });
    }

    if (privileged) {
      const dbKeys = new Set(dbVms.map((v) => `${v.vmid}@${v.node}`));
      for (const res of resources) {
        if (Number(res.template ?? 0) === 1) continue;
        const key = `${Number(res.vmid)}@${String(res.node)}`;
        if (dbKeys.has(key)) continue;
        items.push({
          id: null,
          vmid: Number(res.vmid),
          node: String(res.node ?? ""),
          name: String(res.name ?? ""),
          tracked: false,
          status: String(res.status ?? "unknown"),
          osType: null,
          osName: null,
          os: friendlyOstypeFromProxmox(String(res.ostype ?? "")),
          ip: null,
          cpu: res.cpu != null ? { used: res.cpu, max: Number(res.maxcpu ?? 0) } : null,
          mem: res.mem != null ? { used: res.mem, max: Number(res.maxmem ?? 0) } : null,
          disk: res.disk != null ? { used: res.disk, max: Number(res.maxdisk ?? 0) } : null,
          uptime: res.uptime != null ? Number(res.uptime) : null,
          guacamole: { created: false, status: null, protocol: null, port: null },
          credentialStatus: null,
          templateId: null,
        });
      }
    }

    return { vms: items, proxmoxConnected, proxmoxError };
  });

  app.get("/vms/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const access = await resolveVmAccess(request, id);
    if (!access.allowed) throw AppError.forbidden();
    const vm = await ctx.vms.findById(id);
    if (!vm) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "VM not found" });
    }
    let proxmox: Record<string, unknown> | null = null;
    let proxmoxError: string | null = null;
    try {
      const client = await ctx.getProxmoxClient();
      proxmox = (await client.qemuStatus(vm.node, vm.vmid)) as Record<string, unknown>;
      if (String(proxmox.status ?? "") === "running") {
        vm.status = "running";
      } else if (vm.status === "running") {
        vm.status = "stopped";
      }
    } catch (err) {
      proxmoxError = err instanceof Error ? err.message : String(err);
    }
    const guac = await ctx.guac.listConnectionRecords(vm.id);
    const viewerAccess = await ctx.vms.hasAccessOrOwns(vm.id, access.user.id);
    const primaryGuac = guac.length ? guac[0] : null;
    const cred = await ctx.creds.findByVm(vm.id);
    const jobs = (await ctx.jobs.list({ vmId: vm.id, limit: 10 })).map((j) => ({ ...j, request: undefined }));
    const audit = await ctx.audit.list({ vmId: vm.id, limit: 25 });
    const accessUserIds = await ctx.vms.listAccessUserIds(vm.id);
    return {
      vm: {
        id: vm.id,
        vmid: vm.vmid,
        node: vm.node,
        name: vm.name,
        status: vm.status,
        osType: vm.osType,
        osName: vm.osName,
        os: vm.osName ?? friendlyOsType(vm.osType),
        ip: vm.ipAddress,
        createdAt: vm.createdAt,
        private: vm.privacyFlag,
        viewerAccess,
      },
      proxmox,
      proxmoxError,
      guacamole: {
        connections: guac.map((g) => ({
          status: g.status,
          protocol: g.protocol,
          hostname: g.hostname,
          port: g.port,
          username: g.username,
          connectionName: g.guac_connection_name,
          lastVerifiedAt: g.last_verified_at,
        })),
        active: primaryGuac
          ? {
              status: primaryGuac.status,
              protocol: primaryGuac.protocol,
              hostname: primaryGuac.hostname,
              port: primaryGuac.port,
              username: primaryGuac.username,
              connectionName: primaryGuac.guac_connection_name,
              lastVerifiedAt: primaryGuac.last_verified_at,
            }
          : null,
      },
      credential: cred
        ? {
            username: cred.username,
            status: cred.status,
            createdAt: cred.created_at,
            lastVerifiedAt: cred.last_verified_at,
            lastRotatedAt: cred.last_rotated_at,
          }
        : null,
      jobs,
      audit,
      accessUserIds,
    };
  });

  app.post("/vms/:id/start", async (request) => {
    const { id } = request.params as { id: string };
    const access = await resolveVmAccess(request, id);
    if (!access.allowed) throw AppError.forbidden();
    const user = await app.requirePermission(["vm.manage", "vm.start"])(request);
    const vm = await ctx.vms.requireById(id);
    const client = await ctx.getProxmoxClient();
    const upid = await client.start(vm.node, vm.vmid);
    if (upid) await client.waitForTask(vm.node, upid, 120000);
    await ctx.vms.updateStatus(vm.id, "running");
    await ctx.audit.record({
      event: "VM_STARTED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
    });
    return { ok: true };
  });

  app.post("/vms/:id/stop", async (request) => {
    const { id } = request.params as { id: string };
    const access = await resolveVmAccess(request, id);
    if (!access.allowed) throw AppError.forbidden();
    const user = await app.requirePermission(["vm.manage", "vm.stop"])(request);
    const vm = await ctx.vms.requireById(id);
    const body = actionBody.safeParse(request.body ?? {});
    const client = await ctx.getProxmoxClient();
    const upid =
      body.success && body.data.force
        ? await client.stop(vm.node, vm.vmid, 30)
        : await client.shutdown(vm.node, vm.vmid);
    if (upid) await client.waitForTask(vm.node, upid, 120000);
    await ctx.vms.updateStatus(vm.id, "stopped");
    await ctx.audit.record({
      event: "VM_STOPPED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { mode: body.success && body.data.force ? "hard" : "graceful" },
    });
    return { ok: true };
  });

  app.post("/vms/:id/restart", async (request) => {
    const { id } = request.params as { id: string };
    const access = await resolveVmAccess(request, id);
    if (!access.allowed) throw AppError.forbidden();
    const user = await app.requirePermission(["vm.manage", "vm.restart"])(request);
    const vm = await ctx.vms.requireById(id);
    const client = await ctx.getProxmoxClient();
    const upid = await client.reboot(vm.node, vm.vmid);
    if (upid) await client.waitForTask(vm.node, upid, 180000);
    await ctx.audit.record({
      event: "VM_RESTARTED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
    });
    return { ok: true };
  });

  // -- One-click clone ------------------------------------------------------
  app.post("/vms/:id/clone", async (request) => {
    const { id } = request.params as { id: string };
    const access = await resolveVmAccess(request, id);
    if (!access.allowed) throw AppError.forbidden();
    const user = await app.requirePermission("vm.create")(request);
    const body = z
      .object({
        name: z.string().min(1).max(128),
        target: z.string().min(1).max(128).optional(),
        storage: z.string().min(1).max(128).optional(),
      })
      .parse(request.body);
    const vm = await ctx.vms.requireById(id);
    const client = await ctx.getProxmoxClient();
    // Allocate a free VMID without colliding with tracked rows.
    const taken = new Set(await ctx.vms.listVmidsByNode(body.target ?? vm.node));
    let vmid = await client.nextId();
    let guard = 0;
    while (taken.has(vmid) && guard++ < 1000) vmid += 1;
    if (guard >= 1000) throw AppError.conflict(`No free VM ID found on node ${body.target ?? vm.node}.`);
    const upid = await client.clone({
      node: vm.node,
      templateVmid: vm.vmid,
      newVmid: vmid,
      name: body.name,
      full: true,
      storage: body.storage,
      target: body.target,
    });
    if (upid) await client.waitForTask(vm.node, upid, 900000);
    const record = await ctx.vms.create({
      vmid,
      node: body.target ?? vm.node,
      name: body.name,
      status: "stopped",
      osType: vm.osType ?? undefined,
      createdByUserId: user.id,
    });
    await ctx.vms.setAccess(record.id, user.id);
    await ctx.audit.record({
      event: "VM_CLONED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: record.id,
      detail: { sourceVmId: vm.id, sourceVmid: vm.vmid, newVmid: vmid, target: body.target ?? vm.node },
    });
    return { vm: record };
  });

  // -- Save running VM as template -------------------------------------------
  app.post("/vms/:id/make-template", async (request) => {
    const { id } = request.params as { id: string };
    const access = await resolveVmAccess(request, id);
    if (!access.allowed) throw AppError.forbidden();
    const user = await app.requirePermission("templates.manage")(request);
    const body = z.object({ name: z.string().min(1).max(128) }).parse(request.body);
    const vm = await ctx.vms.requireById(id);
    if (vm.status === "running") {
      throw AppError.validation("Stop the VM before converting it into a template");
    }
    const client = await ctx.getProxmoxClient();
    const upid = await client.makeTemplate(vm.node, vm.vmid);
    if (upid) await client.waitForTask(vm.node, upid, 600000);
    const osType = vm.osType ?? "linux";
    const template = await ctx.templates.register({
      name: body.name,
      node: vm.node,
      proxmoxVmid: vm.vmid,
      osType,
      provisioningMethod: osType === "windows" ? "cloudbase-init" : "cloud-init",
      cloudInitSupport: true,
      guestAgentRequired: true,
      defaultCpu: 2,
      defaultRamMb: 2048,
      defaultDiskGb: 20,
      supportedProtocols: [osType === "windows" ? "rdp" : "ssh"] as ("ssh" | "rdp" | "vnc")[],
    });
    await ctx.audit.record({
      event: "TEMPLATE_CREATED",
      actorUserId: user.id,
      actorUsername: user.username,
      detail: { name: body.name, vmid: vm.vmid, node: vm.node, sourceVmId: vm.id },
    });
    return { template };
  });

  // -- Live/offline migration --------------------------------------------------
  app.post("/vms/:id/migrate", async (request) => {
    const { id } = request.params as { id: string };
    const access = await resolveVmAccess(request, id);
    if (!access.allowed) throw AppError.forbidden();
    const user = await app.requirePermission("vm.manage")(request);
    const body = z
      .object({ target: z.string().min(1).max(128), online: z.boolean().optional() })
      .parse(request.body);
    const vm = await ctx.vms.requireById(id);
    if (body.target === vm.node) throw AppError.validation("Target node must differ from the current node");
    const client = await ctx.getProxmoxClient();
    const online = body.online ?? vm.status === "running";
    const upid = await client.migrate(vm.node, vm.vmid, body.target, online);
    if (upid) await client.waitForTask(vm.node, upid, 1800000);
    await ctx.vms.updateNode(vm.id, body.target);
    await ctx.audit.record({
      event: "VM_MIGRATED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { from: vm.node, to: body.target, online },
    });
    return { ok: true, node: body.target };
  });

  // -- Resource graphs ---------------------------------------------------------
  app.get("/vms/:id/stats", async (request) => {
    const { id } = request.params as { id: string };
    const access = await resolveVmAccess(request, id);
    if (!access.allowed) throw AppError.forbidden();
    await app.requirePermission("vm.read")(request);
    const query = z
      .object({ timeframe: z.enum(["hour", "day", "week", "month", "year"]).default("day") })
      .parse(request.query);
    const vm = await ctx.vms.requireById(id);
    const client = await ctx.getProxmoxClient();
    const points = await client.rrddata(vm.node, vm.vmid, query.timeframe);
    return { points };
  });

  // -- Bulk power actions --------------------------------------------------------
  // Static segment wins over /vms/:id in Fastify routing; per-item results so
  // one failure never aborts the rest. Each item enforces the same permission
  // and access rules as the single-VM endpoints.
  app.post("/vms/bulk-action", async (request) => {
    const body = z
      .object({ ids: z.array(z.string().uuid()).min(1).max(50), action: z.enum(["start", "stop", "restart"]) })
      .parse(request.body);
    const perm: ("vm.manage" | "vm.start" | "vm.stop" | "vm.restart")[] =
      body.action === "start" ? ["vm.manage", "vm.start"] : body.action === "stop" ? ["vm.manage", "vm.stop"] : ["vm.manage", "vm.restart"];
    const user = await app.requirePermission(perm)(request);
    const client = await ctx.getProxmoxClient();
    const results: Array<{ vmId: string; ok: boolean; error?: string }> = [];
    for (const vmId of [...new Set(body.ids)]) {
      try {
        const access = await resolveVmAccess(request, vmId);
        if (!access.allowed) throw AppError.forbidden("No access to this VM");
        const vm = await ctx.vms.requireById(vmId);
        let upid: string | null = null;
        if (body.action === "start") {
          upid = await client.start(vm.node, vm.vmid);
          if (upid) await client.waitForTask(vm.node, upid, 120000);
          await ctx.vms.updateStatus(vm.id, "running");
          await ctx.audit.record({ event: "VM_STARTED", actorUserId: user.id, actorUsername: user.username, vmId: vm.id });
        } else if (body.action === "stop") {
          upid = await client.shutdown(vm.node, vm.vmid);
          if (upid) await client.waitForTask(vm.node, upid, 120000);
          await ctx.vms.updateStatus(vm.id, "stopped");
          await ctx.audit.record({ event: "VM_STOPPED", actorUserId: user.id, actorUsername: user.username, vmId: vm.id });
        } else {
          upid = await client.reboot(vm.node, vm.vmid);
          if (upid) await client.waitForTask(vm.node, upid, 180000);
          await ctx.audit.record({ event: "VM_RESTARTED", actorUserId: user.id, actorUsername: user.username, vmId: vm.id });
        }
        results.push({ vmId, ok: true });
      } catch (err) {
        results.push({ vmId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { results };
  });

  // -- Scheduled power actions -----------------------------------------------------
  app.get("/schedules", async (request) => {
    const user = await app.requirePermission("vm.manage")(request);
    const schedules = await listSchedules(ctx.db);
    if (isAdmin(user)) return { schedules };
    const visible: typeof schedules = [];
    for (const schedule of schedules) {
      const access = await resolveVmAccess(request, schedule.vmId);
      if (access.allowed) visible.push(schedule);
    }
    return { schedules: visible };
  });

  app.post("/schedules", async (request) => {
    const user = await app.requirePermission("vm.manage")(request);
    const body = z
      .object({
        vmId: z.string().uuid(),
        action: z.enum(["start", "stop", "restart"]),
        hour: z.number().int().min(0).max(23),
        minute: z.number().int().min(0).max(59),
        days: z.string().max(32).optional(),
      })
      .parse(request.body);
    const access = await resolveVmAccess(request, body.vmId);
    if (!access.allowed) throw AppError.forbidden("No access to this VM");
    await ctx.vms.requireById(body.vmId);
    const schedule = await createSchedule(ctx.db, { ...body, createdBy: user.id });
    await ctx.audit.record({
      event: "SCHEDULE_CREATED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: body.vmId,
      detail: { scheduleId: schedule.id, action: body.action, hour: body.hour, minute: body.minute, days: schedule.days },
    });
    return { schedule };
  });

  app.delete("/schedules/:id", async (request, reply) => {
    const user = await app.requirePermission("vm.manage")(request);
    const { id } = request.params as { id: string };
    const schedules = await listSchedules(ctx.db);
    const schedule = schedules.find((s) => s.id === id);
    if (!schedule) return reply.status(404).send({ code: "NOT_FOUND", message: "Schedule not found" });
    const access = await resolveVmAccess(request, schedule.vmId);
    if (!access.allowed) throw AppError.forbidden("No access to this VM");
    await deleteSchedule(ctx.db, id);
    await ctx.audit.record({
      event: "SCHEDULE_DELETED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: schedule.vmId,
      detail: { scheduleId: id },
    });
    return { ok: true };
  });

  app.patch("/schedules/:id", async (request, reply) => {
    const user = await app.requirePermission("vm.manage")(request);
    const { id } = request.params as { id: string };
    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    const schedules = await listSchedules(ctx.db);
    const schedule = schedules.find((s) => s.id === id);
    if (!schedule) return reply.status(404).send({ code: "NOT_FOUND", message: "Schedule not found" });
    const access = await resolveVmAccess(request, schedule.vmId);
    if (!access.allowed) throw AppError.forbidden("No access to this VM");
    await setScheduleEnabled(ctx.db, id, body.enabled);
    return { ok: true };
  });

  // -- Share links -----------------------------------------------------------------
  // Creating/revoking requires vm.edit (access management); redeeming is
  // intentionally unauthenticated (that's the point of a share link) and
  // rate-limited against token guessing — tokens are 256-bit regardless.
  app.post("/vms/:id/share", async (request) => {
    const { id } = request.params as { id: string };
    const access = await resolveVmAccess(request, id);
    if (!access.allowed) throw AppError.forbidden();
    const user = await app.requirePermission("vm.edit")(request);
    const body = z
      .object({
        protocol: z.enum(["ssh", "rdp", "vnc"]),
        expiresInMinutes: z.number().int().min(5).max(10080),
        maxUses: z.number().int().min(1).max(1000).optional(),
      })
      .parse(request.body);
    const vm = await ctx.vms.requireById(id);
    const records = await ctx.guac.listConnectionRecords(vm.id);
    if (!records.some((r) => r.protocol === body.protocol)) {
      throw AppError.notFound(`No Guacamole connection exists for this VM for protocol ${body.protocol}`);
    }
    const { link, token } = await createShareLink(ctx.db, {
      vmId: vm.id,
      protocol: body.protocol,
      expiresInMinutes: body.expiresInMinutes,
      maxUses: body.maxUses ?? null,
      createdBy: user.id,
    });
    await ctx.audit.record({
      event: "SHARE_CREATED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { shareId: link.id, protocol: body.protocol, expiresAt: link.expiresAt, maxUses: link.maxUses },
    });
    return { link, token };
  });

  app.get("/share", async (request) => {
    const user = await app.requirePermission("vm.edit")(request);
    const links = await listShareLinks(ctx.db, isAdmin(user) ? undefined : user.id);
    return { links };
  });

  app.delete("/share/:id", async (request, reply) => {
    const user = await app.requirePermission("vm.edit")(request);
    const { id } = request.params as { id: string };
    const link = await getShareLink(ctx.db, id);
    if (!link) return reply.status(404).send({ code: "NOT_FOUND", message: "Share link not found" });
    if (!isAdmin(user) && link.createdBy !== user.id) {
      throw AppError.forbidden("Only the creator or an administrator can revoke this link");
    }
    await revokeShareLink(ctx.db, id);
    await ctx.audit.record({
      event: "SHARE_REVOKED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: link.vmId,
      detail: { shareId: id },
    });
    return { ok: true };
  });

  app.get(
    "/s/:token",
    { config: { csrf: "skip", rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const link = await redeemShareLink(ctx.db, token);
      if (!link) {
        return reply.status(410).send({ code: "GONE", message: "This share link is invalid, expired, revoked, or used up." });
      }
      const vm = await ctx.vms.requireById(link.vmId);
      // The link rides the creator's Guacamole identity: mint a fresh token
      // now so the shared URL itself never contains a Guacamole credential.
      // If the creator lost Guacamole access, shares die with it.
      const creatorId = link.createdBy;
      const userRecord = creatorId ? await ctx.guac.findUserRecord(creatorId) : null;
      if (!creatorId || !userRecord) {
        return reply.status(410).send({ code: "GONE", message: "This share link is no longer usable." });
      }
      const guacApi = await ctx.getGuacApi();
      const guacSettings = await ctx.settings.guacamole();
      const result = await ctx.guac.launch(
        vm.id,
        creatorId,
        guacApi,
        guacSettings?.url ?? "",
        guacSettings?.publicUrl ?? null,
        link.protocol as "ssh" | "rdp" | "vnc",
      );
      if (result.mode !== "direct") {
        return reply.status(502).send({ code: "GUACAMOLE_ERROR", message: "Guacamole direct launch is unavailable right now." });
      }
      await ctx.audit.record({
        event: "SHARE_REDEEMED",
        vmId: vm.id,
        detail: { shareId: link.id, protocol: link.protocol },
      });
      return reply.redirect(result.url);
    },
  );

  // -- Service discovery ---------------------------------------------------------------
  app.post("/discovery/run", async (request) => {
    const user = await app.requirePermission("proxmox.read")(request);
    const body = z.object({ vmId: z.string().uuid().optional() }).parse(request.body ?? {});
    const privileged = user.roles.includes("ADMIN") || user.roles.includes("OPERATOR");
    const targets = body.vmId
      ? [await ctx.vms.requireById(body.vmId)]
      : privileged
        ? await ctx.vms.list()
        : await ctx.vms.listAssignedToUser(user.id);
    const scanned: Array<{ vmId: string; services: Array<{ port: number; service: string }> }> = [];
    for (const vm of targets) {
      if (!vm.ipAddress) continue;
      const access = await resolveVmAccess(request, vm.id);
      if (!access.allowed) continue;
      const found = await scanVmServices(vm.ipAddress);
      await storeVmServices(ctx.db, vm.id, found);
      scanned.push({ vmId: vm.id, services: found.map(({ port, service }) => ({ port, service })) });
    }
    return { scanned };
  });

  app.get("/vm-services", async (request) => {
    const user = await app.requirePermission("vm.read")(request);
    const privileged = user.roles.includes("ADMIN") || user.roles.includes("OPERATOR");
    const vms = privileged ? await ctx.vms.list() : await ctx.vms.listAssignedToUser(user.id);
    const out: Array<{ vmId: string; services: Array<{ port: number; service: string }> }> = [];
    for (const vm of vms) {
      const services = await listVmServices(ctx.db, vm.id);
      if (services.length) out.push({ vmId: vm.id, services: services.map(({ port, service }) => ({ port, service })) });
    }
    return { vmServices: out };
  });

  app.put("/vms/:id", async (request) => {
    const { id } = request.params as { id: string };
    const access = await resolveVmAccess(request, id);
    if (!access.allowed) throw AppError.forbidden();
    const user = await app.requirePermission("vm.edit")(request);
    const vm = await ctx.vms.requireById(id);
    const body = z
      .object({
        cpu: z.number().int().min(1).max(512).optional(),
        ramMb: z.number().int().min(256).max(1048576).optional(),
        assignToUserIds: z.array(z.string().uuid()).optional(),
      })
      .parse(request.body);

    if (body.cpu !== undefined || body.ramMb !== undefined) {
      const client = await ctx.getProxmoxClient();
      const updates: Record<string, unknown> = {};
      if (body.cpu !== undefined) updates.cores = body.cpu;
      if (body.ramMb !== undefined) updates.memory = body.ramMb;
      const upid = await client.updateConfig(vm.node, vm.vmid, updates);
      if (upid) await client.waitForTask(vm.node, upid, 120000);
    }
    if (body.assignToUserIds !== undefined) {
      // Diff DIRECT grants only: group-derived access is owned by groups and
      // must never be touched here.
      const entries = await ctx.vms.listAccessEntries(vm.id);
      const now = Date.now();
      const liveDirect = new Set(
        entries
          .filter((e) => e.source === "direct" && (!e.expiresAt || new Date(e.expiresAt).getTime() > now))
          .map((e) => e.userId),
      );
      const guacDb = await ctx.getGuacDb();
      for (const userId of body.assignToUserIds) {
        if (!liveDirect.has(userId)) {
          const target = await ctx.users.findById(userId);
          if (!target) continue;
          const protocols = await syncGrantProtocols(vm.id, target.id, target.username);
          await ctx.vms.replaceAccess(vm.id, target.id, { protocols: null, expiresAt: null, createdBy: user.id });
          await ctx.audit.record({
            event: "VM_ACCESS_GRANTED",
            actorUserId: user.id,
            actorUsername: user.username,
            vmId: vm.id,
            detail: { targetUserId: target.id, username: target.username, guacSynced: true, protocols },
          });
        }
      }
      for (const entry of entries) {
        if (entry.source !== "direct") continue;
        if (!body.assignToUserIds.includes(entry.userId)) {
          await ctx.guac.revokeVmAccess(vm.id, entry.userId, guacDb);
          await ctx.vms.revokeAccess(vm.id, entry.userId);
          await ctx.audit.record({
            event: "VM_ACCESS_REVOKED",
            actorUserId: user.id,
            actorUsername: user.username,
            vmId: vm.id,
            detail: { targetUserId: entry.userId, guacSynced: true },
          });
        }
      }
    }
    await ctx.audit.record({
      event: "VM_EDITED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { cpu: body.cpu, ramMb: body.ramMb },
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // VM user-access management (admin/operator only — requires vm.edit).
  // ProxVM vm_access is the source of truth; every grant/revoke also syncs
  // the user's Guacamole permissions across ALL of the VM's connections
  // (ssh/rdp/vnc). Guacamole sync failures never leave a false success:
  // the vm_access row is only written after the Guacamole grant succeeds,
  // and revokes keep the row until the Guacamole revoke succeeds, so
  // retrying is always safe (all operations are idempotent).
  // ---------------------------------------------------------------------------

  const syncGrantProtocols = async (vmId: string, targetUserId: string, targetUsername: string): Promise<string[]> => {
    const guacDb = await ctx.getGuacDb();
    await ctx.guac.ensureGuacUser(targetUserId, targetUsername, guacDb);
    await ctx.guac.grantVmAccess(vmId, targetUserId, guacDb);
    const records = await ctx.guac.listConnectionRecords(vmId);
    return records.map((r) => r.protocol);
  };

  app.get("/vms/:id/access", async (request) => {
    const { id } = request.params as { id: string };
    const actor = await app.requirePermission("vm.edit")(request);
    const vm = await ctx.vms.requireById(id);
    if (vm.privacyFlag && !(await ctx.vms.hasAccess(vm.id, actor.id))) {
      throw AppError.forbidden("This VM is privacy-flagged: access management requires a direct grant");
    }
    const entries = await ctx.vms.listAccessEntries(vm.id);
    const access = [];
    for (const entry of entries) {
      const target = await ctx.users.findById(entry.userId);
      if (!target) continue;
      access.push({
        user: toPublicUser(target),
        createdAt: entry.createdAt,
        createdBy: entry.createdBy,
        protocols: entry.protocols,
        expiresAt: entry.expiresAt,
        source: entry.source,
        groupId: entry.groupId ?? null,
        groupName: entry.groupName ?? null,
      });
    }
    return { vmId: vm.id, access };
  });

  app.post("/vms/:id/access", async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = await app.requirePermission("vm.edit")(request);
    const vm = await ctx.vms.requireById(id);
    if (vm.privacyFlag && !(await ctx.vms.hasAccess(vm.id, actor.id))) {
      throw AppError.forbidden("This VM is privacy-flagged: access management requires a direct grant");
    }
    const body = z
      .object({
        userId: z.string().uuid().optional(),
        username: z.string().min(1).max(128).optional(),
        protocols: z.array(z.enum(["ssh", "rdp", "vnc"])).max(3).optional(),
        expiresAt: z.string().datetime({ offset: true }).optional(),
      })
      .refine((b) => b.userId !== undefined || b.username !== undefined, {
        message: "Either userId or username is required",
      })
      .parse(request.body);
    const target = body.userId
      ? await ctx.users.findById(body.userId)
      : await ctx.users.findByUsername(body.username as string);
    if (!target) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "User not found" });
    }
    // Merge with any existing direct row: explicit fields win, otherwise the
    // live row is preserved (idempotent re-grant never wipes scoping).
    const entries = await ctx.vms.listAccessEntries(vm.id);
    const existing = entries.find((e) => e.source === "direct" && e.userId === target.id) ?? null;
    const live = !!existing && (!existing.expiresAt || new Date(existing.expiresAt).getTime() > Date.now());
    const protocols = body.protocols !== undefined ? [...new Set(body.protocols)] : (existing?.protocols ?? null);
    let expiresAt: Date | null = existing?.expiresAt ?? null;
    if (body.expiresAt !== undefined) {
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        throw AppError.validation("expiresAt must be a future date-time");
      }
    }
    await ctx.vms.replaceAccess(vm.id, target.id, { protocols, expiresAt, createdBy: actor.id });
    let effective: string[] | null;
    try {
      ({ protocols: effective } = await reconcileUserVmGuacAccess(ctx, target.id, vm.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.vms.revokeAccess(vm.id, target.id);
      ctx.logger.error(
        { vmId: vm.id, targetUserId: target.id, error: message },
        "vm access grant failed during Guacamole sync; vm_access row rolled back",
      );
      await ctx.audit.record({
        event: "VM_ACCESS_GRANTED",
        actorUserId: actor.id,
        actorUsername: actor.username,
        vmId: vm.id,
        detail: { targetUserId: target.id, username: target.username, guacSynced: false, error: message },
      });
      throw err;
    }
    await ctx.audit.record({
      event: "VM_ACCESS_GRANTED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      vmId: vm.id,
      detail: {
        targetUserId: target.id,
        username: target.username,
        guacSynced: true,
        protocols: effective,
        expiresAt: expiresAt?.toISOString() ?? null,
        alreadyAssigned: live,
      },
    });
    if (expiresAt) {
      await ctx.audit.record({
        event: "TEMPORARY_ACCESS_GRANTED",
        actorUserId: actor.id,
        actorUsername: actor.username,
        vmId: vm.id,
        detail: { targetUserId: target.id, username: target.username, expiresAt: expiresAt.toISOString(), protocols: effective },
      });
    }
    return {
      ok: true,
      changed: !live,
      guacSynced: true,
      protocols: effective,
      expiresAt: expiresAt?.toISOString() ?? null,
      user: toPublicUser(target),
    };
  });

  // Self-service invites: anyone holding access (even without vm.edit) may
  // bring exactly one more person in. This is the path by which a user lets
  // an administrator into a privacy-flagged VM. Invites are audited with the
  // inviter attributed; adjusting or removing other people's rows still needs
  // the vm.edit management endpoints below.
  app.post("/vms/:id/invite", async (request, reply) => {
    const { id } = request.params as { id: string };
    const inviter = await app.requireAuth(request);
    const vm = await ctx.vms.requireById(id);
    if (!(await ctx.vms.hasAccessOrOwns(vm.id, inviter.id))) {
      throw AppError.forbidden("Only someone with access to this VM can invite others");
    }
    const body = z
      .object({
        userId: z.string().uuid().optional(),
        username: z.string().min(1).max(128).optional(),
        protocols: z.array(z.enum(["ssh", "rdp", "vnc"])).max(3).optional(),
        expiresAt: z.string().datetime({ offset: true }).optional(),
      })
      .refine((b) => b.userId !== undefined || b.username !== undefined, {
        message: "Either userId or username is required",
      })
      .parse(request.body);
    const target = body.userId
      ? await ctx.users.findById(body.userId)
      : await ctx.users.findByUsername(body.username as string);
    if (!target) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "User not found" });
    }
    if (await ctx.vms.hasAccess(vm.id, target.id)) {
      return reply.status(409).send({ code: "CONFLICT", message: "That user already has access; ask a manager to adjust it" });
    }
    let expiresAt: Date | null = null;
    if (body.expiresAt !== undefined) {
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        throw AppError.validation("expiresAt must be a future date-time");
      }
    }
    const protocols = body.protocols !== undefined ? [...new Set(body.protocols)] : null;
    await ctx.vms.replaceAccess(vm.id, target.id, { protocols, expiresAt, createdBy: inviter.id });
    // Best-effort Guacamole sync (group-grant philosophy, NOT the managed
    // POST /access rollback): the grant row is the invite itself and must
    // survive Guacamole outages — launch-time sync and the periodic sweep
    // converge permissions later. The outcome is audited honestly either way.
    let effective: string[] | null = protocols;
    let guacSynced = true;
    let guacError: string | null = null;
    try {
      ({ protocols: effective } = await reconcileUserVmGuacAccess(ctx, target.id, vm.id));
    } catch (err) {
      guacSynced = false;
      guacError = err instanceof Error ? err.message : String(err);
      ctx.logger.error(
        { vmId: vm.id, targetUserId: target.id, error: guacError },
        "vm invite Guacamole sync deferred; vm_access row kept",
      );
    }
    await ctx.audit.record({
      event: "VM_ACCESS_GRANTED",
      actorUserId: inviter.id,
      actorUsername: inviter.username,
      vmId: vm.id,
      detail: {
        targetUserId: target.id,
        username: target.username,
        guacSynced,
        ...(guacError ? { guacError } : {}),
        protocols: effective,
        expiresAt: expiresAt?.toISOString() ?? null,
        invited: true,
      },
    });
    if (expiresAt) {
      await ctx.audit.record({
        event: "TEMPORARY_ACCESS_GRANTED",
        actorUserId: inviter.id,
        actorUsername: inviter.username,
        vmId: vm.id,
        detail: { targetUserId: target.id, username: target.username, expiresAt: expiresAt.toISOString(), protocols: effective },
      });
    }
    return { ok: true, guacSynced: true, protocols: effective, user: toPublicUser(target) };
  });

  app.delete("/vms/:id/access/:userId", async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    const actor = await app.requireAuth(request);
    const vm = await ctx.vms.requireById(id);
    if (!z.string().uuid().safeParse(userId).success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "userId must be a valid UUID" });
    }
    // Inviters may withdraw their own invite without vm.edit; everything
    // else goes through the managed path below.
    const entries = await ctx.vms.listAccessEntries(vm.id);
    const ownInvite = entries.find((e) => e.source === "direct" && e.userId === userId && e.createdBy === actor.id);
    if (!ownInvite) {
      await app.requirePermission("vm.edit")(request);
      if (vm.privacyFlag && !(await ctx.vms.hasAccessOrOwns(vm.id, actor.id))) {
        throw AppError.forbidden("This VM is privacy-flagged: access management requires a direct grant");
      }
    }
    const assigned = await ctx.vms.hasAccess(vm.id, userId);
    const target = await ctx.users.findById(userId);
    if (!assigned && !(await ctx.guac.findUserRecord(userId))) {
      // Nothing to revoke anywhere: succeed without touching Guacamole,
      // so idempotent retries work even when Guacamole is unreachable.
      return { ok: true, changed: false, guacSynced: true };
    }
    try {
      const guacDb = await ctx.getGuacDb();
      await ctx.guac.revokeVmAccess(vm.id, userId, guacDb);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error(
        { vmId: vm.id, targetUserId: userId, error: message },
        "vm access revoke failed during Guacamole sync; vm_access row KEPT for safe retry",
      );
      await ctx.audit.record({
        event: "VM_ACCESS_REVOKED",
        actorUserId: actor.id,
        actorUsername: actor.username,
        vmId: vm.id,
        detail: { targetUserId: userId, username: target?.username ?? null, guacSynced: false, error: message },
      });
      throw err;
    }
    await ctx.vms.revokeAccess(vm.id, userId);
    if (assigned) {
      await ctx.audit.record({
        event: "VM_ACCESS_REVOKED",
        actorUserId: actor.id,
        actorUsername: actor.username,
        vmId: vm.id,
        detail: { targetUserId: userId, username: target?.username ?? null, guacSynced: true },
      });
    }
    return { ok: true, changed: assigned, guacSynced: true };
  });

  // -- Privacy flag ---------------------------------------------------------------
  // Toggling requires vm.edit plus (a concrete grant, creator-ownership, OR
  // administrator) — a plain default switch for admins. Flipping the flag
  // grants no data by itself: viewing or managing still needs a grant or
  // ownership. Ownership is implicit so flagging never needs pre-configured
  // grant rows: whoever provisioned the VM always counts.
  app.patch("/vms/:id/privacy", async (request) => {
    const { id } = request.params as { id: string };
    const actor = await app.requirePermission("vm.edit")(request);
    const vm = await ctx.vms.requireById(id);
    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    const granted = await ctx.vms.hasAccessOrOwns(vm.id, actor.id);
    if (!granted && !actor.roles.includes("ADMIN")) {
      throw AppError.forbidden("Toggling privacy requires a direct grant for this VM");
    }
    await ctx.vms.setPrivacyFlag(vm.id, body.enabled);
    await ctx.audit.record({
      event: body.enabled ? "PRIVACY_ENABLED" : "PRIVACY_DISABLED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      vmId: vm.id,
      detail: { granted },
    });
    return { ok: true, private: body.enabled };
  });

  app.put("/vms/:id/ip", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("vm.edit")(request);
    const vm = await ctx.vms.requireById(id);
      if (vm.privacyFlag && !(await ctx.vms.hasAccessOrOwns(vm.id, user.id))) {
      throw AppError.forbidden("This VM is privacy-flagged and you have no grant for it");
    }
    const body = ipOverrideSchema.parse(request.body);
    await ctx.vms.updateIp(vm.id, body.ip);
    await ctx.audit.record({
      event: "VM_EDITED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { ipOverride: body.ip },
    });
    return { ok: true, ip: body.ip };
  });

  app.post("/vms/:id/detect-ip", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("vm.edit")(request);
    const vm = await ctx.vms.requireById(id);
      if (vm.privacyFlag && !(await ctx.vms.hasAccessOrOwns(vm.id, user.id))) {
      throw AppError.forbidden("This VM is privacy-flagged and you have no grant for it");
    }
    const client = await ctx.getProxmoxClient();
    let status: Record<string, unknown> = {};
    try {
      status = await client.qemuStatus(vm.node, vm.vmid);
    } catch {
      // fall through; agent detection will report reachability
    }
    if (String(status.status ?? vm.status) !== "running") {
      return { detected: false, reason: "VM is not running" };
    }
    const agent = await client.guestIpAddresses(vm.node, vm.vmid);
    if (!agent) {
      return { detected: false, reason: "QEMU Guest Agent is not reachable (is it installed and running in the guest?)" };
    }
    const candidate = selectUsableIpv4(agent.ipv4s);
    if (!candidate) {
      return { detected: false, reason: "Guest agent reported no usable LAN IPv4 address", interfaces: agent.interfaces };
    }
    await ctx.vms.updateIp(vm.id, candidate);
    if (!vm.osName) {
      const osinfo = await client.agentOsInfo(vm.node, vm.vmid);
      if (osinfo?.prettyName) await ctx.vms.updateOsInfo(vm.id, osinfo.prettyName);
    }
    return { detected: true, ip: candidate, osName: vm.osName };
  });

  app.delete("/vms/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("vm.delete")(request);
    const vm = await ctx.vms.requireById(id);
      if (vm.privacyFlag && !(await ctx.vms.hasAccessOrOwns(vm.id, user.id))) {
      throw AppError.forbidden("This VM is privacy-flagged and you have no grant for it");
    }
    const body = deleteBody.parse(request.body);
    if (body.confirmText !== `DELETE ${vm.name}`) {
      return reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: `Confirmation text must be exactly: DELETE ${vm.name}`,
      });
    }
    const client = await ctx.getProxmoxClient();
    let proxmoxDeleted = false;
    let proxmoxError: string | null = null;
    try {
      const status = await client.qemuStatus(vm.node, vm.vmid);
      if (String(status.status) === "running") {
        const stopUpid = await client.stop(vm.node, vm.vmid, 60);
        if (stopUpid) await client.waitForTask(vm.node, stopUpid, 180000);
      }
      const upid = await client.delete(vm.node, vm.vmid, true);
      if (upid) await client.waitForTask(vm.node, upid, 180000);
      proxmoxDeleted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/does not exist|not found|404/i.test(message)) {
        proxmoxDeleted = true;
      } else {
        proxmoxError = message;
      }
    }
    if (proxmoxError && proxmoxDeleted === false) {
      throw new AppError(
        "PROXMOX_ERROR",
        `Proxmox VM deletion failed, nothing was removed from ProxVM records: ${proxmoxError}`,
        502,
      );
    }
    try {
      const guacDb = await ctx.getGuacDb();
      await ctx.guac.deleteVmResources(vm.id, guacDb);
    } catch (err) {
      throw new AppError(
        "GUACAMOLE_ERROR",
        `Proxmox VM was deleted but Guacamole cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }
    await ctx.creds.delete(vm.id);
    await ctx.vms.softDelete(vm.id);
    // Soft-delete does not trigger FK cascades: remove access rows explicitly
    // so no dangling assignments survive the VM. Guacamole connections were
    // deleted above via deleteVmResources, which removes all per-user grants.
    const removedAccess = await ctx.vms.revokeAllAccess(vm.id);
    await ctx.audit.record({
      event: "VM_DELETED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { vmid: vm.vmid, node: vm.node, removedAccess },
    });
    return { ok: true, proxmoxDeleted };
  });
}

function friendlyOsType(osType: string | null): string {
  if (osType === "linux") return "Linux";
  if (osType === "windows") return "Windows";
  return "Unknown";
}

function friendlyOstypeFromProxmox(ostype: string): string {
  if (ostype.startsWith("win")) return "Windows";
  if (ostype === "l24" || ostype === "l26") return "Linux";
  return "Unknown";
}
