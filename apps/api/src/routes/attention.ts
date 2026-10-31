// ---------------------------------------------------------------------------
// Admin attention: one polled endpoint behind the sidebar badges, the
//   dashboard strip and the command palette.
// Permissions: auth required; threats only for audit.read holders, tickets
//   only for users.manage holders. Missing permission returns null (the UI
//   simply has nothing to show) — never a 403 for the whole response.
// Rate limits: none. Threat counts are cached process-wide for 30s so ten
//   open admin tabs cost one audit scan, not ten.
// Security: counts only (no finding text, actors or IPs), so this is safe to
//   expose at a coarse level; the detailed view stays behind the board's own
//   audit.read guard. A down Proxmox/audit store degrades to null instead of
//   erroring the shell.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import type { CoreContext } from "@proxvm/core";
import { detectThreats, resolveEffectiveAccess, ticketQueueStats } from "@proxvm/core";

const CACHE_MS = 30_000;
const DAY_MS = 86_400_000;

export interface ThreatAttention {
  critical: number;
  high: number;
  medium: number;
  low: number;
  urgent: number;
}

export interface TicketAttention {
  open: number;
  answered: number;
  closed: number;
  oldestOpenAt: string | null;
}

export async function attentionRoutes(
  app: FastifyInstance,
  opts: { ctx: CoreContext; sharedEgressIps?: string[] },
): Promise<void> {
  const ctx = opts.ctx;
  const sharedEgressIps = opts.sharedEgressIps ?? [];
  let threatCache: { at: number; value: ThreatAttention } | null = null;

  const threatCounts = async (): Promise<ThreatAttention> => {
    const now = Date.now();
    if (threatCache && now - threatCache.at < CACHE_MS) return threatCache.value;
    // Same 1-day window and rule set the board shows for "1 day" (new-IP
    // logins need days>=2 and are therefore absent on both surfaces).
    const rows = await ctx.audit.list({ limit: 5000, since: new Date(now - DAY_MS) });
    const findings = detectThreats(rows, now, { windowDays: 1, sharedEgressIps });
    const value: ThreatAttention = { critical: 0, high: 0, medium: 0, low: 0, urgent: 0 };
    for (const f of findings) value[f.severity] += 1;
    value.urgent = value.critical + value.high;
    threatCache = { at: now, value };
    return value;
  };

  app.get("/attention", async (request) => {
    const user = await app.requireAuth(request);
    const effective = await resolveEffectiveAccess(ctx.db, user.id);
    const isAdminRole = user.roles.includes("ADMIN");
    const canAudit = isAdminRole || effective.permissions.has("audit.read");
    const canManageUsers = isAdminRole || effective.permissions.has("users.manage");

    const threats = canAudit ? await threatCounts().catch(() => null) : null;
    const stats = canManageUsers ? await ticketQueueStats(ctx.db).catch(() => null) : null;
    const tickets: TicketAttention | null = stats
      ? {
          open: stats.open,
          answered: stats.answered,
          closed: stats.closed,
          oldestOpenAt: stats.oldestOpenAt?.toISOString() ?? null,
        }
      : null;

    return { generatedAt: new Date().toISOString(), threats, tickets };
  });
}
