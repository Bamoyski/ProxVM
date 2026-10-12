// ---------------------------------------------------------------------------
// PBS routes: Proxmox Backup Server reachability baseline (configured +
//   reachable + version). Read-only; full scheduling lives in backups.ts.
// Permissions: settings.manage (ADMIN-only surface; backup health is infra).
// Rate limits: none (single version() probe per call; no mutation to guard).
// Security: never returns tokens or datastore secrets — only booleans and
//   the version string; unreachable PBS degrades to a flag, not a 500.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import type { CoreContext } from "@proxvm/core";

// Proxmox Backup Server status — baseline only. Reports whether PBS is
// configured and reachable; the one live call it ever makes is version().
// No backup scheduling exists yet (see docs/pbs-integration.md).
/**
 * Register the PBS reachability baseline endpoint.
 * WHY baseline-only here: scheduling/history need per-VM visibility gates,
 * so they live in backupRoutes while this stays a plain infra health check.
 */
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
