import IORedis from "ioredis";
import { Worker, type Job } from "bullmq";
import {
  loadConfig,
  createCore,
  createPgPool,
  makeLogger,
  createProvisioningQueue,
  isUuid,
  validateQueuePayload,
  PROVISIONING_QUEUE,
  runProvisioningJob,
  handleProvisioningOutcome,
  setWorkerHeartbeat,
  type EnqueueJobData,
} from "@proxvm/core";

async function main(): Promise<void> {
  const logger = makeLogger("worker");
  const config = await loadConfig();
  if (!config) {
    logger.error({}, "ProxVM is not configured. Run the setup wizard (start the API) first.");
    process.exit(1);
  }

  const pool = createPgPool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.name,
    ssl: config.database.ssl,
  });
  await pool.query("SELECT 1");

  const redis = new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db,
    maxRetriesPerRequest: null,
  });

  const ctx = await createCore(config, { db: pool, redis, logger });
  const queue = createProvisioningQueue(redis);

  const worker = new Worker<EnqueueJobData>(
    PROVISIONING_QUEUE,
    async (job: Job<EnqueueJobData>) => {
      // The queue is not a trust boundary (shared Redis): validate the
      // payload before touching Proxmox, and never leave a malformed job's
      // DB row stuck PENDING.
      const parsed = validateQueuePayload(job.data);
      if (!parsed) {
        ctx.logger.error({ data: job.data }, "refusing malformed provisioning job payload");
        try {
          const rawId = (job.data as Partial<EnqueueJobData> | null)?.jobDbId;
          if (typeof rawId === "string" && isUuid(rawId)) {
            await ctx.jobs.updateStatus(rawId, "FAILED", "malformed queue payload");
          }
        } catch {
          // best-effort; the bull job still fails below
        }
        return { outcome: "FAILED" as const };
      }
      const { jobDbId, attempt: cleanAttempt } = parsed;
      ctx.logger.info({ jobDbId, attempt: cleanAttempt }, "processing provisioning job");
      const outcome = await runProvisioningJob(ctx, jobDbId, cleanAttempt);
      const finalOutcome = await handleProvisioningOutcome(ctx, queue, jobDbId, cleanAttempt, outcome);
      return { outcome: finalOutcome };
    },
    {
      connection: redis,
      concurrency: 2,
    },
  );

  worker.on("failed", (job, err) => {
    ctx.logger.error({ jobId: job?.data?.jobDbId, error: err.message }, "bullmq job failed");
  });

    const heartbeat = setInterval(() => setWorkerHeartbeat(redis), 5000);

  const shutdown = async (): Promise<void> => {
    clearInterval(heartbeat);
    await worker.close();
    await queue.close();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });

  logger.info({ queue: PROVISIONING_QUEUE, concurrency: 2 }, "ProxVM worker started");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});