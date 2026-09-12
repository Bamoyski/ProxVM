import type { FastifyInstance } from "fastify";
import {
  buildLocalConfig,
  saveConfig,
  defaultConfigPath,
  loadConfig,
  configExists,
} from "@proxvm/core";
import { ProxmoxClient } from "@proxvm/core";
import { createPgPool } from "@proxvm/core";
import { createGuacamoleDbClient } from "@proxvm/core";
import { hashPassword } from "@proxvm/core";
import { AppError } from "@proxvm/core";
import { parseDbHost, normalizeHttpBaseUrl } from "@proxvm/core";

interface SetupOpts {
  ctx?: import("@proxvm/core").CoreContext;
  setupMode: boolean;
}

export async function setupRoutes(app: FastifyInstance, opts: SetupOpts): Promise<void> {
  const configured = opts.setupMode === false;

  app.get("/setup/status", { config: { csrf: "skip" } }, async () => {
    if (configured) {
      return { mode: "ready", configured: true, restartRequired: false };
    }
    const configFileNow = await configExists();
    if (configFileNow) {
      return {
        mode: "setup",
        configured: false,
        restartRequired: true,
        configFile: defaultConfigPath(),
      };
    }
    return { mode: "setup", configured: false, restartRequired: false, configFile: defaultConfigPath() };
  });

  // The test-* endpoints let callers make the server open connections to
  // arbitrary hosts. In setup mode they must stay open (no users exist yet);
  // once configured they require ADMIN (settings.manage).
  const requireSetupOrAdmin = async (request: Parameters<typeof app.requireAuth>[0]): Promise<void> => {
    if (!configured) return;
    await app.requirePermission("settings.manage")(request);
  };

  app.post("/setup/test-database", { config: { csrf: "skip" } }, async (request) => {
    await requireSetupOrAdmin(request);
    const body = databaseConfigSchema.parse(request.body);
    const pool = createPgPool({
      host: body.host,
      port: body.port,
      user: body.user,
      password: body.password,
      database: body.name,
      ssl: body.ssl,
      connectionTimeoutMillis: 8000,
    });
    try {
      const started = Date.now();
      const result = await pool.query("SELECT version() AS version");
      const version = String((result.rows[0] as { version?: string } | undefined)?.version ?? "");
      return { ok: true, host: body.host, port: body.port, serverVersion: version.split(" ").slice(0, 2).join(" ") };
    } catch (err) {
      return { ok: false, host: body.host, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  app.post("/setup/test-redis", { config: { csrf: "skip" } }, async (request) => {
    await requireSetupOrAdmin(request);
    const body = redisConfigSchema.parse(request.body);
    const IORedis = (await import("ioredis")).default as unknown as new (o: Record<string, unknown>) => import("ioredis").Redis;
    const client = new IORedis({
      host: body.host,
      port: body.port,
      password: body.password || undefined,
      db: body.db,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
    });
    try {
      const pong = await client.ping();
      if (pong !== "PONG") throw new Error(`unexpected PING response: ${String(pong)}`);
      return { ok: true, host: body.host, port: body.port };
    } catch (err) {
      return { ok: false, host: body.host, error: err instanceof Error ? err.message : String(err) };
    } finally {
      client.disconnect();
    }
  });

  app.post("/setup/test-proxmox", { config: { csrf: "skip" } }, async (request) => {
    await requireSetupOrAdmin(request);
    const body = proxmoxConfigSchema.parse(request.body);
    const client = new ProxmoxClient({
      url: body.url,
      tokenId: body.tokenId,
      tokenSecret: body.tokenSecret,
      verifySsl: body.verifySsl,
      timeoutMs: 12000,
    });
    try {
      const version = await client.version();
      const nodes = await client.nodes();
      return {
        ok: true,
        version: version.version,
        release: version.release,
        nodes: nodes.map((n) => ({ node: n.node, status: n.status, online: n.status === "online" })),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.post("/setup/test-guacamole", { config: { csrf: "skip" } }, async (request) => {
    await requireSetupOrAdmin(request);
    const body = guacamoleConfigSchema.parse(request.body);
    let parsedUrl: string;
    const db = parseDbHost(body.dbHost);
    try {
      parsedUrl = normalizeHttpBaseUrl(body.url);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const { client, close } = createGuacamoleDbClient({
      engine: body.dbEngine,
      dbHost: db.host,
      dbPort: db.port ?? body.dbPort,
      dbName: body.dbName,
      dbUser: body.dbUser,
      dbPassword: body.dbPassword,
      dbSsl: body.dbSsl,
    });
    try {
      const check = await client.testConnection();
      let webReachable: boolean | null = null;
      let webDetail: string | null = null;
      try {
        const response = await fetch(parsedUrl, { signal: AbortSignal.timeout(8000), redirect: "follow" });
        webReachable = response.status < 500;
        webDetail = `HTTP ${response.status} at ${parsedUrl}`;
      } catch (err) {
        webReachable = false;
        webDetail = err instanceof Error ? err.message : String(err);
      }
      if (!check.ok) {
        return { ok: false, engine: body.dbEngine, webReachable, webDetail, error: check.detail };
      }
      return { ok: true, engine: body.dbEngine, schemaVersion: check.schemaVersion, webReachable, webDetail };
    } finally {
      await close().catch(() => undefined);
    }
  });

  app.post("/setup/complete", { config: { csrf: "skip" } }, async (request) => {
    if (configured) {
      throw AppError.forbidden("Setup is already complete");
    }
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body !== "object") {
      throw AppError.validation("Request body required");
    }
    const admin = setupAdminSchema.parse(body.admin);
    const database = databaseConfigSchema.parse(body.database);
    const redis = redisConfigSchema.parse(body.redis ?? {});
    const proxmox = proxmoxConfigSchema.parse(body.proxmox);
    const guacamole = guacamoleConfigSchema.parse(body.guacamole);
    if (await configExists()) {
      throw AppError.conflict("Configuration file already exists");
    }

    const config = buildLocalConfig({
      admin: { username: admin.username, email: admin.email, password: admin.password },
      app: {
        sessionDurationHours: admin.sessionDurationHours,
        sessionIdleTimeoutMinutes: admin.sessionIdleTimeoutMinutes,
        cookieSecure: admin.cookieSecure,
      },
      database,
      redis,
    });
    await saveConfig(config);

    const { createCore, makeLogger } = await import("@proxvm/core");
    const IORedis = (await import("ioredis")).default as unknown as new (o: Record<string, unknown>) => import("ioredis").Redis;
    const logger = makeLogger("api");
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
      await pool.end().catch(() => undefined);
      throw AppError.external(
        "PostgreSQL",
        `Cannot connect to the application database: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const redisClient = new IORedis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      db: config.redis.db,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    });
    let redisOk = true;
    try {
      const pong = await redisClient.ping();
      redisOk = pong === "PONG";
    } catch (err) {
      redisOk = false;
      await redisClient.quit().catch(() => undefined);
      await pool.end().catch(() => undefined);
      throw AppError.external(
        "Redis",
        `Cannot connect to Redis at ${config.redis.host}:${config.redis.port}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!redisOk) {
      await redisClient.quit().catch(() => undefined);
      await pool.end().catch(() => undefined);
      throw AppError.external("Redis", "Redis PING failed");
    }

    const ctx = await createCore(config, { db: pool, redis: redisClient, logger });
    const adminUser = await ctx.users.create({
      username: admin.username,
      email: admin.email,
      passwordHash: await hashPassword(admin.password),
      roles: ["ADMIN"],
    });
    await ctx.users.markInitialAdmin(adminUser.id);
    await ctx.settings.set("proxmox.url", proxmox.url, { category: "infrastructure" });
    await ctx.settings.set("proxmox.token_id", proxmox.tokenId, { category: "infrastructure" });
    await ctx.settings.set("proxmox.token_secret", proxmox.tokenSecret, { encrypted: true, category: "infrastructure" });
    await ctx.settings.set("proxmox.verify_ssl", String(proxmox.verifySsl), { category: "infrastructure" });
    if (proxmox.defaultNode) await ctx.settings.set("proxmox.default_node", proxmox.defaultNode, { category: "infrastructure" });
    if (proxmox.defaultStorage) await ctx.settings.set("proxmox.default_storage", proxmox.defaultStorage, { category: "infrastructure" });
    if (proxmox.defaultNetwork) await ctx.settings.set("proxmox.default_network", proxmox.defaultNetwork, { category: "infrastructure" });
    await ctx.settings.set("guacamole.db_engine", guacamole.dbEngine, { category: "infrastructure" });
    await ctx.settings.set("guacamole.url", normalizeHttpBaseUrl(guacamole.url), { category: "infrastructure" });
    if (guacamole.publicUrl) {
      await ctx.settings.set("guacamole.public_url", normalizeHttpBaseUrl(guacamole.publicUrl), { category: "infrastructure" });
    }
    await ctx.settings.set("guacamole.db_host", parseDbHost(guacamole.dbHost).host, { category: "infrastructure" });
    await ctx.settings.set("guacamole.db_port", String(guacamole.dbPort), { category: "infrastructure" });
    await ctx.settings.set("guacamole.db_name", guacamole.dbName, { category: "infrastructure" });
    await ctx.settings.set("guacamole.db_user", guacamole.dbUser, { category: "infrastructure" });
    await ctx.settings.set("guacamole.db_password", guacamole.dbPassword, { encrypted: true, category: "infrastructure" });
    await ctx.settings.set("guacamole.db_ssl", String(guacamole.dbSsl), { category: "infrastructure" });
    await ctx.audit.record({
      event: "SETUP_COMPLETED",
      actorUserId: adminUser.id,
      actorUsername: adminUser.username,
      detail: { proxmoxUrl: proxmox.url, guacamoleUrl: guacamole.url },
    });

    const checks: Record<string, unknown> = {};
    try {
      const client = await ctx.getProxmoxClient();
      const version = await client.version();
      checks.proxmox = { ok: true, version: version.version };
    } catch (err) {
      checks.proxmox = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const guacDb = await ctx.getGuacDb();
      const check = await guacDb.testConnection();
      checks.guacamoleDb = { ok: check.ok, schemaVersion: check.schemaVersion, detail: check.detail };
    } catch (err) {
      checks.guacamoleDb = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    checks.postgresql = { ok: true };
    checks.redis = { ok: true };
    checks.encryption = { ok: true, keyId: config.secrets.masterKeyId, cipher: "aes-256-gcm" };

    return {
      ok: true,
      configFile: defaultConfigPath(),
      checks,
      nextStep: "restart-api",
    };
  });
}

import { databaseConfigSchema, guacamoleConfigSchema, proxmoxConfigSchema, redisConfigSchema, setupAdminSchema } from "@proxvm/shared";