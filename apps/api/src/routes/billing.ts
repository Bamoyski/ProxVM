// ---------------------------------------------------------------------------
// Billing routes: usage metering (summary + CSV), per-user VM quotas,
//   support tickets, and the public announcement read.
// Permissions: usage/quota/ticket-status need users.manage (ADMIN-only);
//   ticket create/list and announcement read need any session (users see
//   only their own tickets; admins see the whole queue).
// Rate limits: ticket creation 20/hr and usage export 30/hr (abuse + scan
//   throttles); reads are otherwise uncapped.
// Security: additive and inert by default (null quota = unlimited); quota
//   changes and ticket transitions are audited with actor + target.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import {
  ADMIN_AUDIENCE,
  AppError,
  createTicket,
  csvCell,
  getAnnouncement,
  getUserQuota,
  isAdmin,
  listTickets,
  monthlyUsage,
  notify,
  setTicketStatus,
  setUserQuota,
  type TicketStatus,
} from "@proxvm/core";

// Billing foundations: usage metering, quotas, support tickets. Everything
// here is additive and inert by default (quotas null = unlimited, no tickets
// = empty lists, no metering rows = zero hours). No existing flow is altered.

const monthSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM")
    .optional(),
});

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function toCsvCell(value: unknown): string {
  return csvCell(value);
}

/**
 * Register usage/quota/ticket/announcement endpoints.
 * WHY split visibility: metering and quotas are admin-only cost controls,
 * while tickets/announcements are user-facing, so one module serves both
 * with per-endpoint guards rather than a shared gate.
 */
export async function billingRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;
  const adminGuard = app.requirePermission("users.manage");

  // -- Usage metering (admins) -------------------------------------------------
  app.get("/usage/summary", { preHandler: adminGuard }, async (request) => {
    const query = monthSchema.parse(request.query);
    const month = query.month ?? currentMonth();
    const rows = await monthlyUsage(ctx.db, month);
    const totalHours = Math.round(rows.reduce((sum, r) => sum + r.hours, 0) * 100) / 100;
    return { month, totalHours, vms: rows };
  });

  app.get("/usage/export", { preHandler: adminGuard, config: { rateLimit: { max: 30, timeWindow: "1 hour" } } }, async (request, reply) => {
    const query = monthSchema.parse(request.query);
    const month = query.month ?? currentMonth();
    const rows = await monthlyUsage(ctx.db, month);
    const lines = ["vm_id,vm_name,hours", ...rows.map((r) => [r.vmId, r.vmName, r.hours].map(toCsvCell).join(","))];
    return reply.header("Content-Type", "text/csv").header("Content-Disposition", `attachment; filename="proxvm-usage-${month}.csv"`).send(lines.join("\n"));
  });

  // -- Quotas (admins) -----------------------------------------------------------
  app.get("/users/:id/quota", { preHandler: adminGuard }, async (request) => {
    const { id } = request.params as { id: string };
    const target = await ctx.users.findById(id);
    if (!target) throw AppError.notFound("User not found");
    return { userId: id, maxVms: await getUserQuota(ctx.db, id) };
  });

  app.put("/users/:id/quota", { preHandler: adminGuard }, async (request) => {
    const actor = await app.requireAuth(request);
    const { id } = request.params as { id: string };
    const target = await ctx.users.findById(id);
    if (!target) throw AppError.notFound("User not found");
    const body = z.object({ maxVms: z.number().int().min(0).max(100000).nullable() }).parse(request.body);
    const maxVms = await setUserQuota(ctx.db, id, body.maxVms);
    await app.audit(request, {
      event: "QUOTA_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { targetUser: target.username, maxVms },
    });
    return { userId: id, maxVms };
  });

  // -- Support tickets ------------------------------------------------------------
  app.post(
    "/tickets",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const user = await app.requireAuth(request);
      const body = z.object({ title: z.string().min(1).max(120), body: z.string().min(1).max(4000) }).parse(request.body);
      const ticket = await createTicket(ctx.db, user.id, body.title, body.body);
      await app.audit(request, {
        event: "TICKET_CREATED",
        actorUserId: user.id,
        actorUsername: user.username,
        detail: { ticketId: ticket.id, title: ticket.title },
      });
      // Admin queue delivery is best-effort: the ticket row is the record;
      // a notification failure must never fail the filing itself.
      try {
        await notify(ctx.db, {
          audience: ADMIN_AUDIENCE,
          kind: "ticket",
          title: `New support ticket from ${user.username}`,
          body: body.title.slice(0, 160),
          link: "/tickets",
        });
      } catch (err) {
        ctx.logger.warn({ error: err instanceof Error ? err.message : String(err) }, "ticket notification failed");
      }
      return reply.status(201).send({ ticket });
    },
  );

  app.get("/tickets", async (request) => {
    const user = await app.requireAuth(request);
    const query = z.object({ status: z.enum(["open", "answered", "closed"]).optional() }).parse(request.query);
    // Administrators see the whole queue; everyone else sees only their own.
    const tickets = await listTickets(ctx.db, {
      userId: isAdmin(user) ? undefined : user.id,
      status: query.status as TicketStatus | undefined,
    });
    return { tickets };
  });

  app.patch("/tickets/:id", { preHandler: adminGuard }, async (request) => {
    const actor = await app.requireAuth(request);
    const { id } = request.params as { id: string };
    const body = z.object({ status: z.enum(["open", "answered", "closed"]) }).parse(request.body);
    const ticket = await setTicketStatus(ctx.db, id, body.status as TicketStatus, actor.id);
    await app.audit(request, {
      event: "TICKET_STATUS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { ticketId: id, status: ticket.status },
    });
    return { ticket };
  });

  // -- Announcements (everyone reads, admins write via settings) -------------------
  app.get("/announcement", async (request) => {
    await app.requireAuth(request);
    return (await getAnnouncement(ctx.settings)) ?? { text: null, level: "info" as const };
  });
}
