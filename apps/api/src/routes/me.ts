import type { FastifyInstance } from "fastify";
import type { CoreContext } from "@proxvm/core";
import { toPublicUser } from "@proxvm/core";

export async function meRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  app.get("/me", async (request) => {
    const user = await app.requireAuth(request);
    const session = await ctx.sessions.findBySid(request.cookies["proxvm_session"] ?? "");
    return {
      user: toPublicUser(user),
      csrfToken: session?.csrfToken ?? null,
      sessionExpiresAt: session?.expiresAt ?? null,
    };
  });
}