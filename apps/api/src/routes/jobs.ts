import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import { AppError, enqueueProvisioningJob, removeBullJob, type EnqueueJobData } from "@proxvm/core";
import type { Queue } from "bullmq";

export async function jobRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  const getQueue = (): Queue<EnqueueJobData> => {
    const queue = (app as unknown as { queue?: Queue<EnqueueJobData> }).queue;
    if (!queue) {
      throw new AppError("CONFIGURATION_ERROR", "Provisioning queue is not available (Redis disconnected?)", 503);
    }
    return queue;
  };

  app.get("/jobs", { preHandler: app.requirePermission("jobs.read") }, async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        status: z.string().optional(),
      })
      .parse(request.query);
    const jobs = await ctx.jobs.list({
      limit: query.limit,
      offset: query.offset,
      status: query.status as never,
    });
    return { jobs: jobs.map((j) => ({ ...j, request: undefined })) };
  });

  app.get("/jobs/:id", { preHandler: app.requirePermission("jobs.read") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await ctx.jobs.get(id);
    if (!job) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Job not found" });
    }
    const steps = await ctx.jobs.getSteps(id);
    const jobRequest = job.request as Record<string, unknown>;
    const safeRequest = jobRequest.password
      ? { ...jobRequest, password: "[REDACTED]", hasPassword: true }
      : { ...jobRequest };
    return { job: { ...job, request: safeRequest }, steps };
  });

  app.post("/jobs/:id/retry", { preHandler: app.requirePermission("jobs.retry") }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requireAuth(request);
    const job = await ctx.jobs.require(id);
    if (job.status === "PENDING" || job.status === "PROVISIONING" || job.status === "WAITING_FOR_GUEST" || job.status === "CREATING" || job.status === "CONFIGURING" || job.status === "VERIFYING" || job.status === "GUACAMOLE_CREATING") {
      throw AppError.conflict("Job is still active; cancel it first");
    }
    await ctx.jobs.resetForRetry(id);
    try {
      const attempt = Number((await ctx.redis.get(`proxvm:job:${id}:attempts`)) ?? "0") + 1;
      await ctx.redis.set(`proxvm:job:${id}:attempts`, String(attempt));
      await enqueueProvisioningJob(getQueue(), ctx.jobs, id, { attempt });
    } catch (err) {
      // Redis/queue outage after reset: restore terminal FAILED state instead
      // of leaving the job PENDING forever with no worker ever picking it up.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await ctx.jobs.updateStatus(id, "FAILED", message);
        await ctx.audit.record({
          event: "PROVISIONING_FAILED",
          actorUserId: user.id,
          actorUsername: user.username,
          jobId: id,
          vmId: job.vmId,
          detail: { error: message, during: "retry-enqueue" },
        });
      } catch {
        // Compensation must never mask the original enqueue error.
      }
      throw err;
    }
    await ctx.audit.record({
      event: "PROVISIONING_RETRIED",
      actorUserId: user.id,
      actorUsername: user.username,
      jobId: id,
      vmId: job.vmId,
    });
    return { ok: true };
  });

  app.post("/jobs/:id/cancel", { preHandler: app.requirePermission("jobs.cancel") }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requireAuth(request);
    const job = await ctx.jobs.require(id);
    if (job.status === "READY" || job.status === "FAILED" || job.status === "CANCELLED") {
      throw AppError.conflict("Job already finished");
    }
    await ctx.jobs.cancel(id);
    if (job.bullJobId) {
      const queue = getQueue();
      await removeBullJob(queue, job.bullJobId);
    }
    await ctx.audit.record({
      event: "PROVISIONING_CANCELLED",
      actorUserId: user.id,
      actorUsername: user.username,
      jobId: id,
      vmId: job.vmId,
    });
    return { ok: true };
  });

  app.post("/jobs/:id/rollback", { preHandler: app.requirePermission("vm.delete") }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requireAuth(request);
    const body = z.object({ action: z.enum(["delete", "keep"]) }).parse(request.body);
    const job = await ctx.jobs.require(id);
    await ctx.audit.record({
      event: "ROLLBACK",
      actorUserId: user.id,
      actorUsername: user.username,
      jobId: id,
      vmId: job.vmId,
      detail: { action: body.action },
    });
    if (body.action === "delete") {
      if (job.vmId) {
        const vm = await ctx.vms.findById(job.vmId);
        if (vm) {
          const client = await ctx.getProxmoxClient();
          try {
            const status = await client.qemuStatus(vm.node, vm.vmid);
            if (String(status.status) === "running") {
              const stopUpid = await client.stop(vm.node, vm.vmid, 60);
              if (stopUpid) await client.waitForTask(vm.node, stopUpid, 180000);
            }
            const upid = await client.delete(vm.node, vm.vmid, true);
            if (upid) await client.waitForTask(vm.node, upid, 180000);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!/does not exist|not found|404/i.test(message)) {
              throw new AppError("PROXMOX_ERROR", `Rollback could not delete the Proxmox VM: ${message}`, 502);
            }
          }
          try {
            const guacDb = await ctx.getGuacDb();
            await ctx.guac.deleteVmResources(vm.id, guacDb);
          } catch {
            // Rollback continues; app records are removed regardless.
          }
          await ctx.creds.delete(vm.id);
          await ctx.vms.softDelete(vm.id);
        }
      }
      await ctx.jobs.cancel(id);
    }
    return { ok: true };
  });

  app.get("/jobs/:id/events", { preHandler: app.requirePermission("jobs.read") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await ctx.jobs.require(id);
    const subscriber = ctx.redis.duplicate();
    const channel = `proxvm:job:${id}`;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      subscriber.removeAllListeners("message");
      // disconnect() (not quit()) is safe even while Redis is unreachable.
      subscriber.disconnect();
    };
    const write = (chunk: string): void => {
      if (!closed && !reply.raw.writableEnded && !request.raw.destroyed) {
        reply.raw.write(chunk);
      }
    };
    subscriber.on("message", (chan: string, message: string) => {
      if (chan !== channel) return;
      write(`event: progress\ndata: ${message}\n\n`);
    });
    subscriber.on("error", (err: Error) => {
      request.log.warn({ error: err.message }, "job events redis subscriber error");
    });
    // Subscribe BEFORE committing the SSE response. With enableOfflineQueue: false,
    // subscribe() throws while Redis is down/reconnecting; fail the request cleanly
    // (the client retries) instead of crashing the process with an unhandled error.
    try {
      await subscriber.subscribe(channel);
    } catch (err) {
      request.log.warn({ error: err instanceof Error ? err.message : String(err) }, "job events redis subscribe failed");
      cleanup();
      if (!reply.raw.headersSent) {
        return reply.code(503).send({ error: "Job event stream unavailable; retry shortly." });
      }
      return;
    }
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    write(`event: connected\ndata: {"jobId":"${id}"}\n\n`);
    heartbeat = setInterval(() => {
      write(`: ping\n\n`);
    }, 15000);
    request.raw.on("close", cleanup);
    await new Promise(() => undefined);
  });
}