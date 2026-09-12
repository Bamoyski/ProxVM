import type { FastifyInstance } from "fastify";
import type { CoreContext } from "@proxvm/core";
import { hasPermission } from "@proxvm/core";

export async function healthRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  app.get("/health", { preHandler: app.requirePermission("health.read") }, async () => {
    const checks = await opts.ctx.runHealthChecks();
    const allOnline = checks.every((c) => c.status === "ONLINE");
    return { healthy: allOnline, checks };
  });
}
