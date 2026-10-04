import Fastify, { type FastifyInstance } from "fastify";
import cors, { type OriginFunction } from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { CoreContext } from "@proxvm/core";
import { AppError, ProxmoxApiError, checkVmHealth, getAllowedWebOrigins, getDomainConfig, getIdlePolicy, reconcileIdleShutdown, reconcileVmPower, resolveDomainRedirect, runDueSchedules, sweepExpiredVmAccess } from "@proxvm/core";
import { ZodError } from "zod";
import { buildAuthPlugin, SESSION_COOKIE } from "./plugins/auth.js";
import { setupRoutes } from "./routes/setup.js";
import { domainRoutes } from "./routes/domains.js";
import { billingRoutes } from "./routes/billing.js";
import { firewallRoutes } from "./routes/firewall.js";
import { contentRoutes } from "./routes/content.js";
import { pbsRoutes } from "./routes/pbs.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { usersRoutes } from "./routes/users.js";
import { proxmoxRoutes } from "./routes/proxmox.js";
import { vmRoutes } from "./routes/vms.js";
import { templateRoutes } from "./routes/templates.js";
import { credentialRoutes } from "./routes/credentials.js";
import { guacamoleRoutes } from "./routes/guacamole.js";
import { jobRoutes } from "./routes/jobs.js";
import { auditRoutes } from "./routes/audit.js";
import { settingsRoutes } from "./routes/settings.js";
import { healthRoutes } from "./routes/health.js";
import { iamRoutes } from "./routes/iam.js";

export interface BuildAppOptions {
  ctx?: CoreContext;
  setupMode: boolean;
  queue?: unknown;
  webOrigin?: string;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // Secure by default: derive the client IP from the socket, never from
    // X-Forwarded-For (whose leftmost entries anyone can spoof). Rate limits
    // and audit IPs keyed off request.ip are then spoof-proof. Set
    // PROXVM_TRUST_PROXY=1 ONLY when a reverse proxy you control is
    // guaranteed in front (it appends the real client IP last) and you need
    // true client IPs in logs — and understand spoofed prefixes are trusted.
    trustProxy: process.env.PROXVM_TRUST_PROXY === "1",
    bodyLimit: 1024 * 1024,
  });

  await app.register(rateLimit, {
    global: true,
    max: 400,
    timeWindow: "1 minute",
  });

  await app.register(cookie, {});

  // CORS allowlist is dynamic: the configured env origin is always honored,
  // and once a canonical domain exists its https origin (plus every redirect
  // alias) is accepted too — otherwise a domain switch would lock the new
  // domain out until someone edits the env and restarts. Evaluated per
  // request from settings so switches take effect with no restart.
  if (opts.webOrigin) {
    const staticOrigin = opts.webOrigin;
    const corsDelegate: OriginFunction = (origin, cb) => {
      void (async () => {
        try {
          if (!origin) return cb(null, true);
          if (origin === staticOrigin) return cb(null, true);
          if (opts.ctx && !opts.setupMode) {
            const config = await getDomainConfig(opts.ctx.settings).catch(() => null);
            if (config && getAllowedWebOrigins(staticOrigin, config).includes(origin)) {
              return cb(null, true);
            }
          }
          return cb(null, false);
        } catch {
          return cb(null, false);
        }
      })();
    };
    await app.register(cors, {
      origin: corsDelegate,
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-CSRF-Token"],
    });
  }

  // Defense-in-depth response headers for the JSON/SSE API (the nginx layer
  // sends its own set for the proxied path; duplicates are harmless).
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    // Duck-type ZodError (name + issues) instead of relying solely on
    // instanceof: the zod CJS and ESM builds expose distinct class objects,
    // so cross-package ZodErrors can fail an instanceof check.
    if (error instanceof ZodError || (error as { name?: unknown; issues?: unknown }).name === "ZodError") {
      const issues = ((error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues ?? []);
      const message =
        issues.map((i) => `${(i.path ?? []).join(".") || "value"}: ${i.message}`).join("; ") || "Invalid request";
      void reply.status(400).send({ code: "VALIDATION_ERROR", message });
      return;
    }
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        ...(error.details ? { explanation: error.details } : {}),
      });
      return;
    }
    if (error instanceof ProxmoxApiError) {
      // Report Proxmox upstream failures accurately (bad gateway), never as an
      // opaque 500. Log the structured detail for diagnosis.
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          logger: "api",
          path: request.method + " " + request.url,
          msg: "Proxmox upstream error",
          upstreamStatus: error.statusCode,
          error: error.message,
          detail: error.detail,
        }),
      );
      void reply.status(502).send({ code: "PROXMOX_ERROR", message: error.message, detail: error.detail });
      return;
    }
    const err = error as { statusCode?: number; message?: string };
    if (err.statusCode === 429) {
      void reply.status(429).send({ code: "RATE_LIMITED", message: "Too many requests. Please slow down." });
      return;
    }
    const statusCode = err.statusCode ?? 500;
    const message = statusCode < 500 ? (err.message ?? "Request failed") : "Internal server error";
    if (statusCode >= 500) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          logger: "api",
          path: request.method + " " + request.url,
          msg: message,
          error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
        }),
      );
    }
    void reply.status(statusCode).send({ code: "INTERNAL_ERROR", message });
  });

  if (!opts.setupMode && opts.ctx) {
    const ctx: CoreContext = opts.ctx;
    // Canonical-domain redirect: old domains (kept as aliases after a
    // switch) 301 to the current domain. Unknown hosts serve normally so
    // localhost/IP access never breaks. Runs before auth so share links work.
    app.addHook("onRequest", async (request, reply) => {
      const config = await getDomainConfig(ctx.settings).catch(() => null);
      if (!config?.canonical) return;
      const rawHost = request.headers.host;
      const target = resolveDomainRedirect({
        host: Array.isArray(rawHost) ? rawHost[0] : rawHost,
        url: request.url,
        method: request.method,
        canonical: config.canonical,
        aliases: config.aliases,
      });
      if (target) {
        reply.redirect(target, 301);
        return;
      }
      return;
    });
    await app.register(buildAuthPlugin(ctx));
    await app.register(setupRoutes, { prefix: "/api", ctx, setupMode: false });
    await app.register(authRoutes, { prefix: "/api", ctx });
    await app.register(meRoutes, { prefix: "/api", ctx });
    await app.register(usersRoutes, { prefix: "/api", ctx });
    await app.register(proxmoxRoutes, { prefix: "/api", ctx });
    await app.register(vmRoutes, { prefix: "/api", ctx });
    await app.register(templateRoutes, { prefix: "/api", ctx });
    await app.register(credentialRoutes, { prefix: "/api", ctx });
    await app.register(guacamoleRoutes, { prefix: "/api", ctx });
    await app.register(jobRoutes, { prefix: "/api", ctx });
    await app.register(auditRoutes, { prefix: "/api", ctx });
    await app.register(settingsRoutes, { prefix: "/api", ctx });
    await app.register(healthRoutes, { prefix: "/api", ctx });
    await app.register(iamRoutes, { prefix: "/api", ctx });
    await app.register(domainRoutes, { prefix: "/api", ctx });
    await app.register(billingRoutes, { prefix: "/api", ctx });
    await app.register(firewallRoutes, { prefix: "/api", ctx });
    await app.register(contentRoutes, { prefix: "/api", ctx });
    await app.register(pbsRoutes, { prefix: "/api", ctx });
    startSessionCleanup(app, ctx);
    startIamSweep(app, ctx);
    startHomelabTickers(app, ctx);
  } else {
    await app.register(setupRoutes, { prefix: "/api", setupMode: true });
  }

  app.get("/api/health/live", async () => ({ status: "OK" }));

  return app;
}

export { SESSION_COOKIE };

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Periodically prunes long-expired/revoked sessions. Without this the
 * sessions table grows without bound (every login inserts a row; logout
 * only marks revoked). Exported for testing.
 */
const SCHEDULE_TICK_MS = 60 * 1000;
const HEALTH_TICK_MS = 5 * 60 * 1000;

/**
 * Background homelab tickers: scheduled power actions every minute,
 * connection-health snapshots every 5 minutes (first health pass starts on
 * the first tick to avoid hammering Guacamole at boot). Exported for testing.
 */
export function startHomelabTickers(
  app: FastifyInstance,
  ctx: CoreContext,
  scheduleIntervalMs = SCHEDULE_TICK_MS,
  healthIntervalMs = HEALTH_TICK_MS,
): void {
  const runSchedules = async (): Promise<void> => {
    try {
      const result = await runDueSchedules({
        db: ctx.db,
        vms: ctx.vms,
        getProxmoxClient: () => ctx.getProxmoxClient(),
        audit: ctx.audit,
        logger: ctx.logger,
      });
      if (result.ran > 0) ctx.logger.info(result, "scheduled power actions completed");
    } catch (err) {
      ctx.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "scheduled power actions failed",
      );
    }
  };
  const runHealth = async (): Promise<void> => {
    try {
      const vms = await ctx.vms.list();
      let checked = 0;
      for (const vm of vms) {
        try {
          await checkVmHealth(ctx.db, ctx.guac, vm.id);
          checked += 1;
        } catch (err) {
          ctx.logger.warn(
            { vmId: vm.id, error: err instanceof Error ? err.message : String(err) },
            "connection health check failed",
          );
        }
      }
      if (checked > 0) ctx.logger.debug({ checked }, "connection health pass completed");
    } catch (err) {
      ctx.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "connection health pass failed",
      );
    }
  };
  // Usage metering reconciler: compares live Proxmox power state against
  // open metering periods and opens/closes on transitions only. Catches
  // out-of-band changes (someone powers a VM on in Proxmox directly) and
  // heals any missed action hooks. Read-only apart from metering rows;
  // never touches VM power itself.
  const runMetering = async (): Promise<void> => {
    try {
      const vms = await ctx.vms.list();
      let client: Awaited<ReturnType<typeof ctx.getProxmoxClient>> | null = null;
      try {
        client = await ctx.getProxmoxClient();
      } catch {
        return;
      }
      for (const vm of vms) {
        try {
          const status = await client.qemuStatus(vm.node, vm.vmid);
          const running = String((status as Record<string, unknown>).status ?? "").toLowerCase() === "running";
          const changed = await reconcileVmPower(ctx.db, vm.id, running);
          if (changed !== "unchanged") {
            ctx.logger.debug({ vmId: vm.id, changed }, "metering period transition");
          }
        } catch (err) {
          ctx.logger.warn(
            { vmId: vm.id, error: err instanceof Error ? err.message : String(err) },
            "metering reconcile failed for VM",
          );
        }
      }
    } catch (err) {
      ctx.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "metering reconcile pass failed",
      );
    }
  };
  // Idle auto-shutdown: user-class VMs with no sessions, idle CPU, and no
  // recent activity get a graceful ACPI shutdown. Server-class VMs are never
  // touched, and the whole pass is a no-op unless the global switch is on.
  const runPower = async (): Promise<void> => {
    try {
      const policy = await getIdlePolicy(ctx.settings);
      if (!policy.enabled) return;
      const outcomes = await reconcileIdleShutdown(
        {
          db: ctx.db,
          vms: ctx.vms,
          guac: ctx.guac,
          getProxmoxClient: () => ctx.getProxmoxClient(),
          getGuacDb: () => ctx.getGuacDb(),
          audit: ctx.audit,
          logger: ctx.logger,
        },
        policy,
      );
      const shut = outcomes.filter((o) => o.shutdown);
      if (shut.length > 0) {
        ctx.logger.info(
          { vms: shut.map((o) => ({ id: o.vmId, name: o.name, reason: o.reason })) },
          "idle auto-shutdown completed",
        );
      }
    } catch (err) {
      ctx.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "idle auto-shutdown pass failed",
      );
    }
  };
  void runSchedules();
  void runMetering();
  void runPower();
  const scheduleTimer = setInterval(() => {
    void runSchedules();
  }, scheduleIntervalMs);
  const healthTimer = setInterval(() => {
    void runHealth();
  }, healthIntervalMs);
  const meteringTimer = setInterval(() => {
    void runMetering();
  }, healthIntervalMs);
  const powerTimer = setInterval(() => {
    void runPower();
  }, healthIntervalMs);
  for (const timer of [scheduleTimer, healthTimer, meteringTimer, powerTimer]) {
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  app.addHook("onClose", async () => {
    clearInterval(scheduleTimer);
    clearInterval(healthTimer);
    clearInterval(meteringTimer);
    clearInterval(powerTimer);
  });
}

export function startIamSweep(app: FastifyInstance, ctx: CoreContext, intervalMs = SESSION_CLEANUP_INTERVAL_MS): void {
  // Prunes expired IAM rows and revokes leftover Guacamole permissions.
  // Authorization never depends on this (resolution ignores expired rows);
  // it only reclaims access that already stopped working.
  const run = async (): Promise<void> => {
    try {
      const result = await sweepExpiredVmAccess(ctx);
      if (result.revoked > 0 || result.errors > 0) {
        ctx.logger.info({ revoked: result.revoked, errors: result.errors }, "iam expiry sweep completed");
      }
    } catch (err) {
      ctx.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "iam expiry sweep failed",
      );
    }
  };
  void run();
  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}

export function startSessionCleanup(
  app: FastifyInstance,
  ctx: CoreContext,
  intervalMs = SESSION_CLEANUP_INTERVAL_MS,
): void {
  const run = async (): Promise<void> => {
    try {
      await ctx.sessions.cleanup();
    } catch (err) {
      ctx.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "session cleanup failed",
      );
    }
    // Optional audit retention (audit.retention_days setting, unset = keep forever).
    try {
      const retention = await ctx.settings.get("audit.retention_days");
      const days = retention ? Number(retention.value) : NaN;
      if (Number.isFinite(days) && days >= 1) {
        const removed = await ctx.audit.prune(Math.floor(days));
        if (removed > 0) ctx.logger.info({ removed }, "audit retention prune completed");
      }
    } catch (err) {
      ctx.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "audit retention prune failed",
      );
    }
  };
  void run();
  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  // Never keep the process (or vitest workers) alive just for cleanup.
  (timer as unknown as { unref?: () => void }).unref?.();
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}