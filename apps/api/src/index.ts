import { loadConfig, defaultConfigPath, createCore, createPgPool, makeLogger, createProvisioningQueue, type EnqueueJobData } from "@proxvm/core";
import { buildApp } from "./app.js";
import IORedis from "ioredis";
import type { Queue } from "bullmq";

async function main(): Promise<void> {
  const logger = makeLogger("api");
  const port = Number(process.env.PROXVM_PORT ?? "4000");
  const host = process.env.PROXVM_HOST ?? "0.0.0.0";
  const webOrigin = process.env.PROXVM_WEB_ORIGIN ?? "http://localhost:5173";

  const config = await loadConfig();
  if (!config) {
    logger.warn({}, "ProxVM is not configured. Starting in setup mode.");
    const app = await buildApp({ setupMode: true, webOrigin });
    await app.listen({ port, host });
    logger.info({ url: `http://localhost:${port}` }, "ProxVM setup wizard available");
    return;
  }

  const pool = createPgPool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.name,
    ssl: config.database.ssl,
  });
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "Cannot connect to the application database");
    process.exit(1);
  }

    const redis: IORedis = new IORedis({    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
  redis.on("error", (err: Error) => {
    logger.warn({ error: err.message }, "Redis connection error");
  });

  const ctx = await createCore(config, { db: pool, redis, logger });
  const queue = createProvisioningQueue(redis);

  const app = await buildApp({ ctx, setupMode: false, queue, webOrigin });
  (app as unknown as { queue: Queue<EnqueueJobData> }).queue = queue;

  await app.listen({ port, host });
  logger.info({ url: `http://localhost:${port}` }, "ProxVM API started");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});