import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import {
  listNotifications,
  markNotificationsRead,
  resolveEffectiveAccess,
  unreadNotificationCount,
} from "@proxvm/core";

// ---------------------------------------------------------------------------
// In-app notifications: the topbar bell. Admins (users.manage holders) see
// the admin queue plus personal rows; everyone else sees only their own.
// Read state is per-row; marking read is scoped so one user can never clear
// another's queue. Cheap endpoints — the bell polls unread-count.
// ---------------------------------------------------------------------------
export async function notificationRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  const viewerOf = async (request: Parameters<typeof app.requireAuth>[0]) => {
    const user = await app.requireAuth(request);
    let isAdmin = user.roles.includes("ADMIN");
    if (!isAdmin) {
      // Custom roles can carry users.manage too — resolve, don't guess.
      const effective = await resolveEffectiveAccess(ctx.db, user.id);
      isAdmin = effective.permissions.has("users.manage");
    }
    return { userId: user.id, isAdmin };
  };

  app.get("/notifications", async (request) => {
    const viewer = await viewerOf(request);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(request.query);
    return { notifications: await listNotifications(ctx.db, viewer, query.limit) };
  });

  app.get("/notifications/unread-count", async (request) => {
    const viewer = await viewerOf(request);
    return { count: await unreadNotificationCount(ctx.db, viewer) };
  });

  app.post("/notifications/read", async (request) => {
    const viewer = await viewerOf(request);
    const body = z
      .object({ ids: z.array(z.guid()).max(100).optional(), all: z.boolean().optional() })
      .parse(request.body ?? {});
    return { marked: await markNotificationsRead(ctx.db, viewer, body) };
  });
}
