// ---------------------------------------------------------------------------
// API entrypoint: boots Fastify in setup mode (unconfigured, wizard only)
//   or configured mode (DB + Redis + CoreContext + provisioning queue).
// Security: setup mode is unauthenticated by design and must never face
//   untrusted networks; configured mode warns (or refuses, with the env
//   override) on insecure cookies / plaintext public origins.
// ---------------------------------------------------------------------------
import { loadConfig, defaultConfigPath, createCore, createPgPool, makeLogger, createProvisioningQueue, type EnqueueJobData } from "@proxvm/core";
import { buildApp } from "./app.js";
import { initSetupToken } from "./routes/setup.js";
import IORedis from "ioredis";
import type { Queue } from "bullmq";

/**
 * Boot the API: setup wizard when no config exists, full stack otherwise.
 * WHY fail fast on DB/cookie misconfig: serving traffic without storage or
 * with downgraded session security would silently corrupt or expose data.
 */
async function main(): Promise<void> {
  const logger = makeLogger("api");
  const port = Number(process.env.PROXVM_PORT ?? "4000");
  const host = process.env.PROXVM_HOST ?? "0.0.0.0";
  const webOrigin = process.env.PROXVM_WEB_ORIGIN ?? "http://localhost:5173";

  const config = await loadConfig();
  if (!config) {
    logger.warn({}, "ProxVM is not configured. Starting in setup mode.");
    // Setup mode is unauthenticated by design (no users exist yet): never
    // expose an unconfigured instance to untrusted networks. Finish setup
    // promptly and restart immediately afterward — setup endpoints stay live
    // until the process restarts into configured mode.
    const app = await buildApp({ setupMode: true, webOrigin });
    await app.listen({ port, host });
    logger.info({ url: `http://localhost:${port}` }, "ProxVM setup wizard available");
    // One-time setup token: every setup endpoint except status requires it
    // as X-Setup-Token. Read this from the server console, not the network.
    logger.info({ setupToken: initSetupToken() }, "Setup token (enter in the wizard; rotates on completion)");
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

  // Open-internet sanity checks: insecure cookies or a plaintext public
  // origin silently downgrade session security. Warn loudly instead of
  // refusing to boot (local HTTP development still needs to work).
  if (!config.app.cookieSecure) {
    const enforceSecure = process.env.PROXVM_ENFORCE_SECURE_COOKIES === "1";
    if (enforceSecure) {
      logger.error({}, "PROXVM_ENFORCE_SECURE_COOKIES=1 but cookieSecure is false. Refusing to start.");
      process.exit(1);
    }
    logger.warn({}, "Session cookies are NOT Secure-flagged. Enable cookieSecure (Settings) before exposing ProxVM to the open internet.");
  }
  if (/^http:\/\//i.test(webOrigin) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(webOrigin)) {
    logger.warn({ webOrigin }, "Public web origin uses plaintext HTTP. Terminate TLS in front of ProxVM for open-internet use.");
  }

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