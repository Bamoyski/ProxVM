import type { FastifyInstance } from "fastify";
import type { CoreContext } from "@proxvm/core";

// Proxmox Backup Server status — baseline only. Reports whether PBS is
// configured and reachable; the one live call it ever makes is version().
// No backup scheduling exists yet (see docs/pbs-integration.md).
export async function pbsRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;
  const guard = app.requirePermission("settings.manage");

  app.get("/pbs/status", { preHandler: guard }, async () => {
    const client = await ctx.getPbsClient();
    if (!client) {
      return { configured: false, reachable: false, version: null as string | null };
    }
    try {
      const version = await client.version();
      return { configured: true, reachable: true, version: version.version };
    } catch (err) {
      ctx.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "PBS configured but unreachable",
      );
      return { configured: true, reachable: false, version: null as string | null };
    }
  });
}
