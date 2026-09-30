import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import http from "node:http";
import IORedis from "ioredis";
import type { JobType } from "bullmq";
import {
  AppError,
  createCore,
  createPgPool,
  createProvisioningQueue,
  loadConfig,
  makeLogger,
  timingSafeEqualStr,
  type CoreContext,
} from "@proxvm/core";
import type { UserWithRoles } from "@proxvm/shared";
import { isReadOnlyStatement, parseBearerToken, stripDockerStream } from "./inspect.js";

// Overwatch: god-mode observability for the ProxVM operator. Separate port,
// separate threat model from the main API:
//
// - ADMIN role AND a static bearer token (PROXVM_OVERWATCH_TOKEN, fail closed
//   when unset). Either check failing denies; denials are logged.
// - Binds 127.0.0.1 by default. Expose it further only behind something that
//   authenticates (Cloudflare Access, Tailscale) — never the open internet.
// - Deliberately NO CORS plugin: browsers on other origins cannot even read
//   responses, which makes the bearer token CSRF-proof.
// - Read-only everywhere except the SQL console, which is itself
//   statement-gated AND wrapped in a server-enforced READ ONLY transaction.

const OVERWATCH_COOKIE = "proxvm_session"; // must match apps/api SESSION_COOKIE
const SQL_ROW_CAP = 200;

interface OverwatchRequest extends FastifyRequest {
  owUser?: UserWithRoles;
}

async function extremeGuard(ctx: CoreContext, request: OverwatchRequest): Promise<UserWithRoles> {
  const required = (process.env.PROXVM_OVERWATCH_TOKEN ?? "").trim();
  if (!required) {
    throw new AppError("CONFIGURATION_ERROR", "Overwatch is not configured (PROXVM_OVERWATCH_TOKEN).", 503);
  }
  const got = parseBearerToken(request.headers.authorization);
  if (!timingSafeEqualStr(required, got)) {
    ctx.logger.warn({ method: request.method, url: request.url }, "overwatch denied: bad or missing bearer token");
    throw AppError.unauthorized();
  }
  const sid = request.cookies[OVERWATCH_COOKIE];
  const session = typeof sid === "string" && sid ? await ctx.sessions.validate(sid) : null;
  const user = session ? await ctx.users.findById(session.userId) : null;
  if (!user || !user.active || !user.roles.includes("ADMIN")) {
    ctx.logger.warn(
      { method: request.method, url: request.url, userId: user?.id ?? null },
      "overwatch denied: admin session required",
    );
    throw AppError.unauthorized();
  }
  return user;
}

type OwContext = CoreContext & { queue: { getJobCounts: (...args: JobType[]) => Promise<Record<string, number>> } };

async function overview(ctx: OwContext) {
  const out: Record<string, unknown> = { now: new Date().toISOString() };
  const attempt = async <T>(key: string, fn: () => Promise<T>): Promise<void> => {
    try {
      out[key] = await fn();
    } catch (err) {
      out[key] = null;
      ctx.logger.warn({ key, error: err instanceof Error ? err.message : String(err) }, "overwatch overview partial");
    }
  };
  await attempt("users", async () => {
    const users = await ctx.users.list();
    return { total: users.length, admins: users.filter((u) => u.roles.includes("ADMIN")).length, disabled: users.filter((u) => !u.active).length };
  });
  await attempt("vms", async () => {
    const vms = await ctx.vms.list();
    const byStatus: Record<string, number> = {};
    for (const vm of vms) byStatus[vm.status] = (byStatus[vm.status] ?? 0) + 1;
    return { total: vms.length, byStatus, isolated: vms.filter((v) => v.firewallIsolated).length };
  });
  await attempt("jobs", async () => {
    const rows = await ctx.db.query<{ status: string; count: string }>(
      "SELECT status, COUNT(*) AS count FROM provisioning_jobs GROUP BY status",
    );
    const byStatus: Record<string, number> = {};
    for (const r of rows.rows) byStatus[r.status] = Number(r.count);
    return byStatus;
  });
  await attempt("sessions", async () => {
    const rows = await ctx.db.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NULL AND expires_at > NOW()",
    );
    return { active: Number(rows.rows[0]?.count ?? 0) };
  });
  await attempt("tickets", async () => {
    const rows = await ctx.db.query<{ status: string; count: string }>(
      "SELECT status, COUNT(*) AS count FROM support_tickets GROUP BY status",
    );
    const byStatus: Record<string, number> = {};
    for (const r of rows.rows) byStatus[r.status] = Number(r.count);
    return byStatus;
  });
  await attempt("audit24h", async () => {
    const rows = await ctx.db.query<{ event: string; count: string }>(
      "SELECT event, COUNT(*) AS count FROM audit_logs WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY event ORDER BY COUNT(*) DESC LIMIT 20",
    );
    return rows.rows.map((r) => ({ event: r.event, count: Number(r.count) }));
  });
  await attempt("database", async () => {
    const rows = await ctx.db.query<{ size: string }>("SELECT pg_database_size(current_database())::text AS size");
    return { bytes: Number(rows.rows[0]?.size ?? 0) };
  });
  await attempt("queue", async () => {
    const counts = await ctx.queue.getJobCounts("waiting", "active", "delayed", "failed", "paused");
    return counts;
  });
  await attempt("proxmox", async () => {
    const client = await ctx.getProxmoxClient();
    const [nodes, resources] = await Promise.all([client.nodes(), client.clusterResources()]);
    const guests = resources.filter((r) => Number(r.template ?? 0) !== 1);
    return {
      nodes: nodes.map((n) => ({ node: n.node, status: n.status, uptime: n.uptime })),
      guests: guests.length,
      running: guests.filter((r) => String((r as unknown as Record<string, unknown>).status ?? "") === "running").length,
    };
  });
  return out;
}

function dockerRequest(path: string): Promise<{ status: number; body: Buffer }> {
  const socketPath = (process.env.DOCKER_SOCK ?? "").trim();
  if (!socketPath) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "Container logs need the Docker socket: mount /var/run/docker.sock read-only and set DOCKER_SOCK=/var/run/docker.sock.",
      503,
    );
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

export async function buildOverwatchApp(ctx: OwContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(cookie, {});
  await app.register(rateLimit, { global: true, max: 60, timeWindow: "1 minute" });

  app.get("/healthz", async () => ({ status: "OK", service: "overwatch" }));

  app.get("/overview", async (request) => {
    await extremeGuard(ctx, request as OverwatchRequest);
    return overview(ctx);
  });

  app.get("/activity", async (request) => {
    const user = await extremeGuard(ctx, request as OverwatchRequest);
    void user;
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), event: z.string().max(64).optional() }).parse(request.query);
    return { entries: await ctx.audit.list({ limit: query.limit, event: query.event }) };
  });

  app.get("/sessions", async (request) => {
    await extremeGuard(ctx, request as OverwatchRequest);
    // Never expose sid hashes or CSRF tokens — metadata only.
    const rows = await ctx.db.query(
      `SELECT s.id, u.username, s.ip, s.user_agent, s.created_at, s.last_active_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.revoked_at IS NULL AND s.expires_at > NOW()
       ORDER BY s.last_active_at DESC LIMIT 200`,
    );
    return { sessions: rows.rows };
  });

  app.get("/queue", async (request) => {
    await extremeGuard(ctx, request as OverwatchRequest);
    return ctx.queue.getJobCounts("waiting", "active", "delayed", "failed", "paused");
  });

  app.get("/proxmox/summary", async (request) => {
    await extremeGuard(ctx, request as OverwatchRequest);
    try {
      const client = await ctx.getProxmoxClient();
      const [nodes, resources] = await Promise.all([client.nodes(), client.clusterResources()]);
      return { configured: true, nodes, guests: resources.filter((r) => Number(r.template ?? 0) !== 1).length };
    } catch (err) {
      return { configured: false, detail: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get("/docker/logs", async (request) => {
    await extremeGuard(ctx, request as OverwatchRequest);
    const query = z.object({ service: z.string().regex(/^[a-z0-9-]+$/i).max(40), tail: z.coerce.number().int().min(1).max(2000).default(200) }).parse(request.query);
    const list = await dockerRequest("/containers/json");
    if (list.status !== 200) throw AppError.external("Docker", `daemon returned HTTP ${list.status}`);
    const containers = JSON.parse(list.body.toString("utf8")) as Array<{ Id: string; Names: string[] }>;
    const match = containers.find((c) => (c.Names ?? []).some((n) => n.includes(query.service)));
    if (!match) throw AppError.notFound(`No running container matches "${query.service}"`);
    const logs = await dockerRequest(`/containers/${match.Id}/logs?stdout=1&stderr=1&tail=${query.tail}`);
    if (logs.status !== 200) throw AppError.external("Docker", `logs returned HTTP ${logs.status}`);
    const text = stripDockerStream(logs.body);
    return { service: query.service, logs: text.slice(-200_000) };
  });

  app.post("/sql", async (request, reply) => {
    const user = await extremeGuard(ctx, request as OverwatchRequest);
    const body = z.object({ query: z.string().min(1).max(5000) }).parse(request.body);
    const sql = body.query.trim();
    if (!isReadOnlyStatement(sql)) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "Read-only console: SELECT/WITH/EXPLAIN/SHOW only" });
    }
    // Belt AND suspenders: the regex above is the UX gate; the READ ONLY
    // transaction below is the enforcement (multi-statement writes fail
    // server-side even if smuggled past the regex).
    const client = await (ctx.db as unknown as { connect: () => Promise<{
      query: (q: string | { text: string }) => Promise<{ rows: unknown[]; fields: Array<{ name: string }> }>;
      release: () => void;
    }> }).connect();
    try {
      await client.query("START TRANSACTION READ ONLY");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const result = await client.query({ text: sql });
      await client.query("ROLLBACK");
      const columns = result.fields.map((f) => f.name);
      const rows = result.rows.slice(0, SQL_ROW_CAP);
      await ctx.audit.record({
        event: "OVERWATCH_SQL",
        actorUserId: user.id,
        actorUsername: user.username,
        detail: { query: sql.slice(0, 500), rowCount: result.rows.length, truncated: result.rows.length > SQL_ROW_CAP },
      });
      return { columns, rows, rowCount: result.rows.length, truncated: result.rows.length > SQL_ROW_CAP };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // already dead; release below
      }
      throw err instanceof AppError
        ? err
        : AppError.external("Postgres", err instanceof Error ? err.message.slice(0, 200) : String(err));
    } finally {
      client.release();
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const err = error as { statusCode?: number; message?: string };
    const statusCode = err.statusCode ?? 500;
    const message = statusCode < 500 ? (err.message ?? "Request failed") : "Internal server error";
    if (statusCode >= 500) {
      ctx.logger.error({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) }, "overwatch error");
    }
    void reply.status(statusCode).send({ code: "INTERNAL_ERROR", message });
  });

  return app;
}

async function main(): Promise<void> {
  const logger = makeLogger("overwatch");
  const port = Number(process.env.PROXVM_OVERWATCH_PORT ?? "4001");
  // 0.0.0.0 *inside the container* is required: Docker port publishing
  // forwards to the container address, so a loopback-only listener accepts
  // the TCP handshake (via the proxy) and then drops it — the classic
  // "empty response" symptom. Host exposure is controlled one layer up, by
  // the compose `127.0.0.1:4001:4001` mapping. Do not "fix" this back to
  // 127.0.0.1 without also changing how the port is published.
  const host = process.env.PROXVM_OVERWATCH_HOST ?? "0.0.0.0";
  const config = await loadConfig();
  if (!config) {
    logger.error({}, "Overwatch requires a configured ProxVM (run setup first)");
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
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "Cannot connect to the application database");
    process.exit(1);
  }
  const redis = new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
  const ctx = await createCore(config, { db: pool, redis, logger });
  const queue = createProvisioningQueue(redis);
  const app = await buildOverwatchApp({ ...ctx, queue });
  await app.listen({ port, host });
  logger.info({ url: `http://${host}:${port}` }, "Overwatch console started");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
