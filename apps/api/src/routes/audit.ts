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
  app.get(
    "/audit",
    { preHandler: app.requirePermission("audit.read") },
    async (request) => {
      const query = querySchema.parse(request.query);
      const entries = await ctx.audit.list({
        limit: query.limit,
        offset: query.offset,
        event: query.event,
        vmId: query.vmId,
      });
      return { entries };
    },
  );
}
