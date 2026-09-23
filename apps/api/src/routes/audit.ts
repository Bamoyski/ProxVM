import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  event: z.string().max(64).optional(),
  vmId: z.string().uuid().optional(),
});

export async function auditRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  // Entries tied to privacy-flagged VMs are visible only with a concrete
  // grant — otherwise audit.read would leak private VM activity (including
  // credential reveal/copy events) to ungranted administrators.
  const withoutPrivateEntries = async <T extends { vmId: string | null }>(
    userId: string,
    entries: T[],
  ): Promise<T[]> => {
    const flagCache = new Map<string, boolean>();
    const out: T[] = [];
    for (const entry of entries) {
      if (!entry.vmId) {
        out.push(entry);
        continue;
      }
      let flagged = flagCache.get(entry.vmId);
      if (flagged === undefined) {
        const vm = await ctx.vms.findById(entry.vmId);
        flagged = !!vm?.privacyFlag;
        flagCache.set(entry.vmId, flagged);
      }
      if (flagged && !(await ctx.vms.hasAccessOrOwns(entry.vmId, userId))) continue;
      out.push(entry);
    }
    return out;
  };

  app.get(
    "/audit",
    { preHandler: app.requirePermission("audit.read") },
    async (request) => {
      const query = querySchema.parse(request.query);
      const user = await app.requireAuth(request);
      const entries = await ctx.audit.list({
        limit: query.limit,
        offset: query.offset,
        event: query.event,
        vmId: query.vmId,
      });
      return { entries: await withoutPrivateEntries(user.id, entries) };
    },
  );

  // CSV export honoring the same filters. Capped to keep exports bounded;
  // page through with offset for full retention dumps.
  app.get(
    "/audit/export",
    { preHandler: app.requirePermission("audit.read") },
    async (request, reply) => {
      const query = querySchema.extend({ limit: z.coerce.number().int().min(1).max(50000).default(1000) }).parse(
        request.query,
      );
      const user = await app.requireAuth(request);
      const entries = await withoutPrivateEntries(
        user.id,
        await ctx.audit.list({
          limit: query.limit,
          offset: query.offset,
          event: query.event,
          vmId: query.vmId,
        }),
      );
      const cell = (value: unknown): string => {
        const text = value === null || value === undefined ? "" : String(value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const header = "id,created_at,event,actor_username,vm_id,job_id,ip,detail";
      const lines = entries.map((e) =>
        [e.id, e.createdAt, e.event, e.actorUsername, e.vmId, e.jobId, e.ip, e.detail].map(cell).join(","),
      );
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="proxvm-audit.csv"')
        .send([header, ...lines].join("\n"));
    },
  );
}
