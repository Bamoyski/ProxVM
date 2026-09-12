import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import {
  AppError,
  enqueueProvisioningJob,
  reconcileUserVmGuacAccess,
  resolveProvisionDefaults,
  resolveProvisionRequest,
  selectUsableIpv4,
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

  const resolveVmAccess = async (request: Parameters<typeof app.requireAuth>[0], vmId: string) => {
    const user = await app.requireAuth(request);
    if (user.roles.includes("ADMIN") || user.roles.includes("OPERATOR")) {
      return { user, allowed: true };
    }
    const allowed = await ctx.vms.hasAccess(vmId, user.id);
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
    const dbVms = privileged ? await ctx.vms.list() : await ctx.vms.listAssignedToUser(user.id);

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
    await app.requirePermission("vm.edit")(request);
    const vm = await ctx.vms.requireById(id);
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

  app.delete("/vms/:id/access/:userId", async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    const actor = await app.requirePermission("vm.edit")(request);
    const vm = await ctx.vms.requireById(id);
    if (!z.string().uuid().safeParse(userId).success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "userId must be a valid UUID" });
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

  app.put("/vms/:id/ip", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("vm.edit")(request);
    const vm = await ctx.vms.requireById(id);
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
    await app.requirePermission("vm.edit")(request);
    const vm = await ctx.vms.requireById(id);
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
