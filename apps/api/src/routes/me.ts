// ---------------------------------------------------------------------------
// Me routes: current-session identity (public user + CSRF token + expiry).
// Permissions: any authenticated session; no named permission required.
// Rate limits: none (cheap session lookup on every page load).
// Security: returns the sanitized public user only (never password hashes);
//   CSRF token is re-exposed here so the SPA can recover it after reload.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import type { CoreContext } from "@proxvm/core";
import { toPublicUser } from "@proxvm/core";

/**
 * Register the current-session identity endpoint.
 * WHY session lookup plus auth: requireAuth proves the cookie is valid while
 * the session row supplies the live CSRF token and expiry for the SPA.
 */
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