// ---------------------------------------------------------------------------
// Threats routes: point-in-time findings recomputed from the audit trail
//   (brute force, new-IP logins, out-of-band Proxmox power changes).
// Permissions: audit.read (same visibility as the audit log itself).
// Rate limits: none (read-only recomputation over a bounded 5000-event
//   window; days clamped to 1..30 to bound scan cost).
// Security: findings carry no VM names/ids so privacy-flagged entries need
//   no extra filtering; a down Proxmox API skips the live rule instead of
//   failing the page (liveChecked reports whether it ran).
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import { detectOutOfBand, detectThreats, findNewIpLogins, type LiveVmPower } from "@proxvm/core";

// Threat detection: point-in-time findings recomputed from the audit trail
// on every request. Same visibility as the audit log itself (audit.read);
// findings carry no VM names/ids so privacy-flagged entries need no extra
// filtering. Shared egress hops (PROXVM_TRUST_PROXY) are passed in from the
// app so IP-based rules never blame the tunnel/docker hop for one client.
/**
 * Register the threat-findings endpoint.
 * WHY recompute per request: findings are a view over the audit trail, not
 * stored state, so they can never go stale or desync from retention prunes.
 */
export async function threatRoutes(
  app: FastifyInstance,
  opts: { ctx: CoreContext; sharedEgressIps?: string[] },
): Promise<void> {
  const ctx = opts.ctx;
  const sharedEgressIps = opts.sharedEgressIps ?? [];

  app.get(
    "/threats",
    { preHandler: app.requirePermission("audit.read") },
    async (request) => {
      const query = z
        .object({ days: z.coerce.number().int().min(1).max(30).default(7) })
        .parse(request.query);
      const since = new Date(Date.now() - query.days * 86400000);
      const rows = await ctx.audit.list({ limit: 5000, since });
      const findings = detectThreats(rows, Date.now(), { windowDays: query.days, sharedEgressIps });
      if (query.days >= 2) {
        findings.push(...(await findNewIpLogins(ctx.db, query.days, { sharedEgressIps })));
      }
      // Out-of-band power changes: guests running in Proxmox with no
      // ProxVM-recorded start. Best-effort — a down Proxmox API skips the
      // rule instead of failing the page.
      let liveChecked = false;
      try {
        const client = await ctx.getProxmoxClient();
        const vms = await ctx.vms.list();
        const byKey = new Map(vms.map((vm) => [`${vm.vmid}@${vm.node}`, vm.id]));
        const resources = await client.clusterResources();
        const live: LiveVmPower[] = [];
        for (const r of resources) {
          if (r.template === 1) continue;
          live.push({
            vmId: byKey.get(`${r.vmid}@${r.node}`) ?? null,
            vmid: r.vmid,
            node: r.node,
            running: r.status === "running",
          });
        }
        findings.push(...detectOutOfBand(rows, live, Date.now(), { windowDays: query.days }));
        liveChecked = true;
      } catch {
        liveChecked = false;
      }
      return {
        findings,
        evaluatedAt: new Date().toISOString(),
        windowDays: query.days,
        eventsScanned: rows.length,
        liveChecked,
      };
    },
  );
}
