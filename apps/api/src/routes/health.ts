// ---------------------------------------------------------------------------
// Health routes: aggregated dependency checks (DB/Redis/Proxmox/Guac/PBS).
// Permissions: health.read (operator dashboard surface, not public).
// Rate limits: none (cheap read-only probes; no mutation to throttle).
// Security: returns status/latency only — never credentials or connection
//   strings; per-check failures degrade to OFFLINE/ERROR, not 500s.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import type { CoreContext } from "@proxvm/core";
import { hasPermission } from "@proxvm/core";

/**
 * Register the aggregated health-check endpoint.
 * WHY aggregate here: the UI needs one at-a-glance signal, so the route
 * fans out to runHealthChecks and reduces to a single healthy boolean.
 * UNCONFIGURED optional services are a choice, not an outage — they must
 * not flip `healthy` false (and the plumbing that alerts on transitions
 * already ignores any status that is not ERROR).
 */
export async function healthRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  app.get("/health", { preHandler: app.requirePermission("health.read") }, async () => {
    const checks = await opts.ctx.runHealthChecks();
    const allOnline = checks.every((c) => c.status !== "ERROR" && c.status !== "OFFLINE");
    return { healthy: allOnline, checks };
  });
}
