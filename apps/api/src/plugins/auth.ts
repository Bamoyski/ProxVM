import fastifyPlugin from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UserWithRoles } from "@proxvm/shared";
import type { CoreContext } from "@proxvm/core";
import { AppError, checkCsrf, type Permission } from "@proxvm/core";
import { hasPermission, isAdmin, resolveEffectiveAccess } from "@proxvm/core";

export interface FastifyAuthRequest extends FastifyRequest {
  user: UserWithRoles | null;
  sessionId: string | null;
}

export const SESSION_COOKIE = "proxvm_session";

export function buildAuthPlugin(ctx: CoreContext) {
  return fastifyPlugin(async function authPlugin(app: FastifyInstance): Promise<void> {
    app.decorateRequest("user", null);
    app.decorateRequest("sessionId", null);

    app.addHook("onRequest", async (request: FastifyAuthRequest) => {
      const token = request.cookies[SESSION_COOKIE];
      request.user = null;
      request.sessionId = null;
      if (!token) return;
      const session = await ctx.sessions.validate(token);
      if (!session) return;
      const user = await ctx.users.findById(session.userId);
      if (!user || !user.active) return;
      request.user = user;
      request.sessionId = session.id;
      void ctx.sessions.touch(session.id).catch(() => undefined);
    });

    app.addHook("preHandler", async (request: FastifyAuthRequest, reply: FastifyReply) => {
      const method = request.method;
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
      const routeConfig = request.routeOptions.config as
        | { csrf?: "required" | "skip" }
        | undefined;
      if (routeConfig?.csrf === "skip") return;
      if (!request.sessionId) return;
      const session = await ctx.sessions.findBySid(request.cookies[SESSION_COOKIE] ?? "");
      if (!session) return;
      checkCsrf(session.csrfToken, request.headers["x-csrf-token"] as string | undefined);
    });

    app.decorate("requireAuth", async (request: FastifyAuthRequest) => {
      if (!request.user) {
        ctx.logger.warn(
          { method: request.method, url: request.url, decision: "deny", reason: "unauthenticated" },
          "authorization denied: unauthenticated request",
        );
        throw AppError.unauthorized();
      }
      return request.user;
    });

    // Accepts one permission or an OR-list. Legacy system-role grants are
    // checked first (zero queries); otherwise the effective IAM grants
    // (custom roles, group roles, direct grants, unexpired) are resolved once
    // per request and memoized on the request object.
    app.decorate(
      "requirePermission",
      (permission: Permission | Permission[]) => async (request: FastifyAuthRequest) => {
        const wanted = Array.isArray(permission) ? permission : [permission];
        const user = request.user;
        if (!user) {
          ctx.logger.warn(
            { method: request.method, url: request.url, permission: wanted, decision: "deny", reason: "unauthenticated" },
            "authorization denied: unauthenticated request",
          );
          throw AppError.unauthorized();
        }
        if (wanted.some((p) => hasPermission(user, p))) {
          ctx.logger.debug(
            {
              method: request.method,
              url: request.url,
              permission: wanted,
              userId: user.id,
              username: user.username,
              roles: user.roles,
              decision: "allow",
              via: "role",
            },
            "authorization granted",
          );
          return user;
        }
        const cache = ((request as unknown as { __permCache?: Map<string, boolean> }).__permCache ??=
          new Map<string, boolean>());
        const missing = wanted.filter((p) => {
          if (cache.has(p)) return !cache.get(p);
          return true;
        });
        if (missing.length) {
          const effective = await resolveEffectiveAccess(ctx.db, user.id);
          for (const p of missing) cache.set(p, effective.permissions.has(p));
        }
        const granted = wanted.find((p) => cache.get(p) === true);
        if (!granted) {
          ctx.logger.warn(
            {
              method: request.method,
              url: request.url,
              permission: wanted,
              userId: user.id,
              username: user.username,
              roles: user.roles,
              decision: "deny",
              reason: "missing_permission",
            },
            "authorization denied: missing permission",
          );
          throw AppError.forbidden().withDetails({
            allowed: false,
            reason: "missing_permission",
            permission: wanted.length === 1 ? wanted[0] : wanted,
          });
        }
        ctx.logger.debug(
          {
            method: request.method,
            url: request.url,
            permission: wanted,
            granted,
            userId: user.id,
            username: user.username,
            roles: user.roles,
            decision: "allow",
            via: "grant",
          },
          "authorization granted",
        );
        return user;
      },
    );

    app.decorate("requireAdmin", async (request: FastifyAuthRequest) => {
      if (!request.user) {
        ctx.logger.warn(
          { method: request.method, url: request.url, decision: "deny", reason: "unauthenticated" },
          "authorization denied: unauthenticated request",
        );
        throw AppError.unauthorized();
      }
      if (!isAdmin(request.user)) {
        ctx.logger.warn(
          {
            method: request.method,
            url: request.url,
            userId: request.user.id,
            username: request.user.username,
            roles: request.user.roles,
            decision: "deny",
            reason: "not_admin",
          },
          "authorization denied: admin required",
        );
        throw AppError.forbidden();
      }
      return request.user;
    });
  });
}
export function authFail(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({ code: "UNAUTHORIZED", message: "Authentication required" });
}

declare module "fastify" {
  interface FastifyRequest {
    user: UserWithRoles | null;
    sessionId: string | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest) => Promise<UserWithRoles>;
    requirePermission: (
      permission: Permission | Permission[],
    ) => (request: FastifyRequest) => Promise<UserWithRoles>;
    requireAdmin: (request: FastifyRequest) => Promise<UserWithRoles>;
  }
}