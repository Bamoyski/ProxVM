// ---------------------------------------------------------------------------
// ProxVM API composition root: builds the Fastify app, registers the auth
// plugin FIRST (everything below depends on requireAuth/requirePermission),
// mounts every route group, and starts the background tickers (schedules,
// health, metering, idle-shutdown, threats, backups, session/IAM sweeps).
//
// Security posture encoded here, not scattered: trustProxy defaults to
// socket-IP-only (X-Forwarded-For is attacker-controlled input), global +
// per-route rate limits, security headers, CSRF on writes, and a 1 MB body
// cap so expensive handlers (Argon2, XML/JSON parses) can't be fed
// unbounded input. Change these defaults only with a security reason.
// ---------------------------------------------------------------------------
import Fastify, { type FastifyInstance } from "fastify";
import cors, { type OriginFunction } from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { CoreContext } from "@proxvm/core";
import { AppError, ProxmoxApiError, alertAdmins, checkVmHealth, evaluateThreatAlerts, getAllowedWebOrigins, getDomainConfig, getIdlePolicy, listConnectionHealth, reconcileIdleShutdown, reconcileVmPower, resolveDomainRedirect, runBackupPass, runDriftPass, runDueSchedules, sweepExpiredVmAccess } from "@proxvm/core";
import { ZodError } from "zod";
import { buildAuthPlugin, SESSION_COOKIE } from "./plugins/auth.js";
import { setupRoutes } from "./routes/setup.js";
import { domainRoutes } from "./routes/domains.js";
import { billingRoutes } from "./routes/billing.js";
import { backupRoutes } from "./routes/backups.js";
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
import { hostKeyRoutes } from "./routes/hostkeys.js";
import { guacamoleRoutes } from "./routes/guacamole.js";
import { jobRoutes } from "./routes/jobs.js";
import { auditRoutes } from "./routes/audit.js";
import { threatRoutes } from "./routes/threats.js";
import { driftRoutes, buildDriftPassDeps } from "./routes/drift.js";
import { settingsRoutes } from "./routes/settings.js";
import { healthRoutes } from "./routes/health.js";
import { iamRoutes } from "./routes/iam.js";
import { notificationRoutes } from "./routes/notifications.js";

/**
 * Parses PROXVM_TRUST_PROXY into a Fastify trustProxy value. Empty/unset —
 * trust nothing (socket IP only). "1"/"true" — trust every hop (legacy,
 * only behind a fully controlled proxy). Anything else — a comma-separated
 * list of CIDRs/hosts whose X-Forwarded-For chain is honored.
 */
export function parseTrustProxy(raw: string | undefined): boolean | string[] {
  if (!raw || !raw.trim() || raw.trim() === "0" || raw.trim().toLowerCase() === "false") return false;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface BuildAppOptions {
  ctx?: CoreContext;
  setupMode: boolean;
  queue?: unknown;
  webOrigin?: string;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  // Parsed once, used twice: Fastify resolves client IPs with it, and
  // threat detection reuses the list as "shared egress" addresses — an
  // address trusted as a proxy hop can never identify a client (every
  // tunneled user arrives as the hop), so IP-correlation rules must not
  // attribute findings to it. The legacy trust-everything values
  // ("1"/"true") cannot be enumerated and suppress nothing.
  const trustProxy = parseTrustProxy(process.env.PROXVM_TRUST_PROXY);
  const sharedEgressIps = Array.isArray(trustProxy) ? trustProxy : [];
  const app = Fastify({
    logger: false,
    // Client-IP handling: derive request.ip from the socket by default and
    // never from X-Forwarded-For (whose entries anyone can spoof). Set
    // PROXVM_TRUST_PROXY to a comma-separated list of CIDRs you control
    // (your reverse proxy / docker network, which appends the real client IP
    // last) to log true client IPs in audit rows and key rate limits per
    // client. PROXVM_TRUST_PROXY=1 trusts every hop (legacy; only behind a
    // proxy you fully control). Direct connections from untrusted addresses
    // always fall back to the socket IP, so exposing :4000 directly stays
    // spoof-proof either way. Tunnel note: the Cloudflare edge appends the
    // true visitor IP inside cloudflared's own appended hop, so trusting the
    // tunnel egress resolves tunneled traffic to real clients while forged
    // outer entries stay ignored. That egress IP needs a DHCP reservation.
    // The same list also feeds threat detection's shared-egress handling
    // (rows carrying a hop address are treated as IP-less there).
    trustProxy,
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
      // Infrastructure detail (hostnames, ports, paths) goes only to infra
      // operators; everyone else gets code + message. request.user is the
      // already-loaded session user — no extra query on the error path.
      const roles = request.user?.roles ?? [];
      const infraViewer = roles.includes("ADMIN") || roles.includes("OPERATOR");
      void reply.status(502).send({
        code: "PROXMOX_ERROR",
        message: error.message,
        ...(infraViewer ? { detail: error.detail } : {}),
      });
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
    startScanDetection(app, ctx);
    await app.register(setupRoutes, { prefix: "/api", ctx, setupMode: false });
    await app.register(authRoutes, { prefix: "/api", ctx });
    await app.register(meRoutes, { prefix: "/api", ctx });
    await app.register(usersRoutes, { prefix: "/api", ctx });
    await app.register(proxmoxRoutes, { prefix: "/api", ctx });
    await app.register(vmRoutes, { prefix: "/api", ctx });
    await app.register(templateRoutes, { prefix: "/api", ctx });
    await app.register(credentialRoutes, { prefix: "/api", ctx });
    await app.register(hostKeyRoutes, { prefix: "/api", ctx });
    await app.register(guacamoleRoutes, { prefix: "/api", ctx });
    await app.register(jobRoutes, { prefix: "/api", ctx });
    await app.register(auditRoutes, { prefix: "/api", ctx });
    await app.register(threatRoutes, { prefix: "/api", ctx, sharedEgressIps });
    await app.register(driftRoutes, { prefix: "/api", ctx });
    await app.register(settingsRoutes, { prefix: "/api", ctx });
    await app.register(healthRoutes, { prefix: "/api", ctx });
    await app.register(iamRoutes, { prefix: "/api", ctx });
    await app.register(notificationRoutes, { prefix: "/api", ctx });
    await app.register(domainRoutes, { prefix: "/api", ctx });
    await app.register(billingRoutes, { prefix: "/api", ctx });
    await app.register(firewallRoutes, { prefix: "/api", ctx });
    await app.register(contentRoutes, { prefix: "/api", ctx });
    await app.register(pbsRoutes, { prefix: "/api", ctx });
    await app.register(backupRoutes, { prefix: "/api", ctx });
    startSessionCleanup(app, ctx);
    startIamSweep(app, ctx);
    startHomelabTickers(app, ctx, SCHEDULE_TICK_MS, HEALTH_TICK_MS, sharedEgressIps);
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
 * Reconnaissance detection: counts denied/error responses per client IP in
 * Redis and writes a single SCAN_DETECTED audit row when an IP crosses the
 * threshold inside the window (then stays quiet for a cooldown hour). Login
 * attempts are excluded — each already gets its own LOGIN_FAILED row.
 * Fail-open by design: telemetry must never break responses.
 */
const SCAN_WINDOW_S = 600;
const SCAN_THRESHOLD = 20;
const SCAN_COOLDOWN_S = 3600;

export function startScanDetection(
  app: FastifyInstance,
  ctx: CoreContext,
  threshold = SCAN_THRESHOLD,
): void {
  app.addHook("onResponse", async (request, reply) => {
    const status = reply.statusCode;
    if (status !== 401 && status !== 403 && status !== 404 && status !== 429) return;
    if (request.url === "/api/auth/login" || request.url.startsWith("/api/auth/login?")) return;
    const ip = request.ip;
    if (!ip) return;
    try {
      const count = await ctx.redis.incr(`proxvm:scan:${ip}`);
      if (count === 1) await ctx.redis.expire(`proxvm:scan:${ip}`, SCAN_WINDOW_S);
      if (count < threshold) return;
      const fired = await ctx.redis.set(`proxvm:scan:fired:${ip}`, "1", "EX", SCAN_COOLDOWN_S, "NX");
      if (!fired) return;
      await ctx.audit.record({
        event: "SCAN_DETECTED",
        actorUserId: request.user?.id ?? null,
        actorUsername: request.user?.username ?? null,
        ip,
        detail: {
          count,
          method: request.method,
          path: (request.url.split("?")[0] ?? "/").slice(0, 128),
          status,
        },
      });
    } catch {
      // fail open
    }
  });
}

/**
 * Background homelab tickers: scheduled power actions every minute,
 * connection-health snapshots every 5 minutes (first health pass starts on
 * the first tick to avoid hammering Guacamole at boot), threat webhook
 * alerts, and infrastructure health probes. `sharedEgressIps` is the
 * trusted-proxy list (see buildApp) so threat alerts skip hop addresses.
 * Exported for testing.
 */
export function startHomelabTickers(
  app: FastifyInstance,
  ctx: CoreContext,
  scheduleIntervalMs = SCHEDULE_TICK_MS,
  healthIntervalMs = HEALTH_TICK_MS,
  sharedEgressIps: string[] = [],
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
    // PBS backups share the minute tick: queue due schedules, start pending
    // runs (vzdump/prune task creation only), and finalize running ones by
    // polling. All phases are non-blocking; failures are per-run audited.
    try {
      const backupDeps = {
        db: ctx.db,
        vms: ctx.vms,
        users: ctx.users,
        settings: ctx.settings,
        getProxmoxClient: () => ctx.getProxmoxClient(),
        getPbsClient: () => ctx.getPbsClient(),
        audit: ctx.audit,
        logger: ctx.logger,
      };
      const result = await runBackupPass(backupDeps);
      if (result.queued > 0 || result.started > 0 || result.finished > 0) {
        ctx.logger.info(result, "backup pass completed");
      }
    } catch (err) {
      ctx.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "backup pass failed",
      );
    }
  };
  const runHealth = async (): Promise<void> => {
    try {
      const vms = await ctx.vms.list();
      let checked = 0;
      for (const vm of vms) {
        try {
          // Snapshot previous reachability first: checkVmHealth overwrites
          // the rows, so the diff (up/down transitions only) must be read
          // before. No previous row = first sighting, store silently.
          const prev = await listConnectionHealth(ctx.db, [vm.id]).catch(() => []);
          const prevByProto = new Map(prev.map((p) => [p.protocol, p.reachable]));
          const results = await checkVmHealth(ctx.db, ctx.guac, vm.id);
          checked += 1;
          for (const r of results) {
            const was = prevByProto.get(r.protocol);
            if (was === undefined || was === r.reachable) continue;
            const proto = r.protocol.toUpperCase();
            if (!r.reachable) {
              await alertAdmins(ctx.db, ctx.settings, ctx.logger, {
                kind: "system",
                title: `VM "${vm.name}" ${proto} unreachable`,
                body: `${proto} to "${vm.name}" (node ${vm.node}, vmid ${vm.vmid}) stopped responding. ${r.detail.slice(0, 300)}`,
                link: `/vms/${vm.id}`,
                priority: 8,
              });
            } else {
              await alertAdmins(ctx.db, ctx.settings, ctx.logger, {
                kind: "system",
                title: `VM "${vm.name}" ${proto} reachable (recovered)`,
                body: `${proto} to "${vm.name}" (node ${vm.node}, vmid ${vm.vmid}) is responding again.`,
                link: `/vms/${vm.id}`,
                priority: 5,
              });
            }
          }
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
            // Power transitions are downtime signals: alert on every edge.
            // reconcileVmPower already dedupes (transition-only), so a steady
            // state never re-fires. alertAdmins never throws.
            if (changed === "closed") {
              await alertAdmins(ctx.db, ctx.settings, ctx.logger, {
                kind: "system",
                title: `VM "${vm.name}" stopped`,
                body: `"${vm.name}" (node ${vm.node}, vmid ${vm.vmid}) is no longer running.`,
                link: `/vms/${vm.id}`,
                priority: 8,
              });
            } else {
              await alertAdmins(ctx.db, ctx.settings, ctx.logger, {
                kind: "system",
                title: `VM "${vm.name}" running (recovered)`,
                body: `"${vm.name}" (node ${vm.node}, vmid ${vm.vmid}) is running again.`,
                link: `/vms/${vm.id}`,
                priority: 5,
              });
            }
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
  // Threat webhook alerts: evaluates recent audit events every tick and
  // POSTs fresh findings at/above the configured severity. No URL
  // configured means this is a cheap no-op.
  const runThreats = async (): Promise<void> => {
    try {
      const result = await evaluateThreatAlerts({ settings: ctx.settings, audit: ctx.audit, sharedEgressIps });
      if (result.fired > 0) {
        ctx.logger.info(result, "threat webhook alerts fired");
        // Admin delivery for the same findings (best-effort; the webhook
        // post already happened — this feeds the in-app bell + Gotify).
        await alertAdmins(ctx.db, ctx.settings, ctx.logger, {
          kind: "threat",
          title: `${result.fired} threat finding${result.fired === 1 ? "" : "s"} need review`,
          body: `${result.evaluated} finding(s) evaluated this tick.`,
          link: "/threats",
          priority: 8,
        });
      }
    } catch (err) {
      ctx.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "threat alert evaluation failed",
      );
    }
  };
  // Infrastructure downtime: point-in-time health probes reduced to
  // ONLINE/ERROR transitions. Previous states persist in Redis; the first
  // pass only stores the baseline so boot never pages. Transition-only, so
  // a steady outage fires once, and recovery fires once.
  const INFRA_STATE_KEY = "proxvm:health:last";
  const runInfra = async (): Promise<void> => {
    try {
      const results = await ctx.runHealthChecks();
      let prev: Record<string, string> | null = null;
      try {
        const raw = await ctx.redis.get(INFRA_STATE_KEY);
        prev = raw ? (JSON.parse(raw) as Record<string, string>) : null;
      } catch {
        prev = null;
      }
      const next: Record<string, string> = {};
      for (const r of results) next[r.name] = r.status;
      try {
        await ctx.redis.set(INFRA_STATE_KEY, JSON.stringify(next));
      } catch {
        // state write failing must never break the pass
      }
      if (!prev) return;
      for (const r of results) {
        const old = prev[r.name];
        if (!old || old === r.status) continue;
        if (r.status === "ERROR") {
          await alertAdmins(ctx.db, ctx.settings, ctx.logger, {
            kind: "system",
            title: `${r.name} is DOWN`,
            body: `${r.name} health check failed: ${(r.detail ?? "no detail").slice(0, 300)}`,
            link: "/health",
            priority: 9,
          });
        } else {
          await alertAdmins(ctx.db, ctx.settings, ctx.logger, {
            kind: "system",
            title: `${r.name} recovered (ONLINE)`,
            body: `${r.name} health check is passing again.`,
            link: "/health",
            priority: 5,
          });
        }
      }
    } catch (err) {
      ctx.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "infrastructure health alert pass failed",
      );
    }
  };
  // Ground-truth drift: reconciles ProxVM's DB against live Proxmox, guest
  // agents and the Guacamole DB every 15 minutes (read-only detection; only
  // findings rows are written). Gated by the drift.enabled switch; fails
  // open (a down Proxmox just skips the pass). New findings alert admins.
  const DRIFT_TICK_MS = 15 * 60 * 1000;
  let driftInFlight = false;
  const runDrift = async (): Promise<void> => {
    // A slow cluster (or a manual run racing the ticker) must not stack two
    // passes: they would double-probe past the cooldown and duplicate alerts.
    if (driftInFlight) {
      ctx.logger.debug({}, "drift pass still running; skipping overlapping tick");
      return;
    }
    driftInFlight = true;
    try {
      const result = await runDriftPass(buildDriftPassDeps(ctx));
      if (result.liveChecked && (result.created > 0 || result.resolved > 0)) {
        ctx.logger.info(
          { created: result.created, updated: result.updated, resolved: result.resolved, exempted: result.exempted },
          "drift pass completed",
        );
      }
      if (result.newFingerprints.length > 0) {
        await alertAdmins(ctx.db, ctx.settings, ctx.logger, {
          kind: "system",
          title: `${result.newFingerprints.length} new drift finding${result.newFingerprints.length === 1 ? "" : "s"}`,
          body: `A drift pass recorded ${result.newFingerprints.length} new ground-truth discrepancies (and resolved ${result.resolved}); ${result.exempted} VM(s) were exempt for active jobs. Review them on the Drift page.`,
          link: "/drift",
          priority: 6,
        });
      }
    } catch (err) {
      ctx.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "drift pass failed",
      );
    } finally {
      driftInFlight = false;
    }
  };
  void runSchedules();
  void runMetering();
  void runPower();
  void runThreats();
  void runInfra();
  void runDrift();
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
  const threatTimer = setInterval(() => {
    void runThreats();
  }, healthIntervalMs);
  const infraTimer = setInterval(() => {
    void runInfra();
  }, healthIntervalMs);
  const driftTimer = setInterval(() => {
    void runDrift();
  }, DRIFT_TICK_MS);
  for (const timer of [scheduleTimer, healthTimer, meteringTimer, powerTimer, threatTimer, infraTimer, driftTimer]) {
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  app.addHook("onClose", async () => {
    clearInterval(scheduleTimer);
    clearInterval(healthTimer);
    clearInterval(meteringTimer);
    clearInterval(powerTimer);
    clearInterval(threatTimer);
    clearInterval(infraTimer);
    clearInterval(driftTimer);
  });
}

export function startIamSweep(app: FastifyInstance, ctx: CoreContext, intervalMs = SESSION_CLEANUP_INTERVAL_MS): void {
  // Prunes expired IAM rows and revokes leftover Guacamole permissions.
  // Authorization never depends on this (resolution ignores expired rows);
  // it only reclaims access that already stopped working. Also prunes stale
  // registration password hashes so pending credentials do not accumulate.
  const run = async (): Promise<void> => {
    try {
      const result = await sweepExpiredVmAccess(ctx);
      if (result.revoked > 0 || result.errors > 0) {
        ctx.logger.info({ revoked: result.revoked, errors: result.errors }, "iam expiry sweep completed");
      }
      const pruned = await ctx.registration.pruneStaleRequests();
      if (pruned.pruned > 0 || pruned.scrubbed > 0) {
        ctx.logger.info(pruned, "registration hash retention sweep completed");
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