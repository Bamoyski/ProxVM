import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import { hashPassword, verifyPassword, toPublicUser } from "@proxvm/core";
import { loginSchema } from "@proxvm/shared";
import { SESSION_COOKIE } from "../plugins/auth.js";

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z
    .string()
    .min(12)
    .regex(/[a-z]/, "Password must contain a lowercase letter")
    .regex(/[A-Z]/, "Password must contain an uppercase letter")
    .regex(/[0-9]/, "Password must contain a number")
    .regex(/[^A-Za-z0-9]/, "Password must contain a special character"),
});

export async function authRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  app.post(
    "/auth/login",
    {
      // Tight per-IP budget for the internet-exposed login: scanning bots
      // burn through it in seconds and get 429s. Legitimate users rarely log
      // in more than a couple of times per minute; shared-NAT false
      // positives are acceptable here because the per-username throttle and
      // per-account lockout below are the precise controls.
      config: { csrf: "skip", rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      // Hard per-username throttle (Redis-backed, spoof-proof unlike IP
      // limits): max 10 attempts/minute for any single account, successful or
      // not. The per-account lockout below remains the backstop for targeted
      // guessing; this fails open if Redis is unreachable so an outage
      // cannot lock everyone out.
      try {
        const key = `proxvm:login-throttle:${body.username.toLowerCase()}`;
        const attempts = await ctx.redis.incr(key);
        if (attempts === 1) await ctx.redis.expire(key, 60);
        if (attempts > 10) {
          return reply.status(429).send({ code: "RATE_LIMITED", message: "Too many login attempts. Please slow down." });
        }
      } catch (err) {
        ctx.logger.warn({ error: err instanceof Error ? err.message : String(err) }, "login throttle unavailable; continuing");
      }
      const user = await ctx.users.findByUsername(body.username);
      if (!user) {
        await ctx.audit.record({
          event: "LOGIN_FAILED",
          actorUsername: body.username,
          ip: request.ip,
          detail: { reason: "unknown-user" },
        });
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Invalid username or password" });
      }
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        const remaining = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
        return reply.status(423).send({
          code: "ACCOUNT_LOCKED",
          message: `Account locked. Try again in ${remaining} minute(s).`,
        });
      }
      const valid = await verifyPassword(user.passwordHash, body.password);
      if (!valid) {
        const result = await ctx.users.recordFailedLogin(body.username, 5, 15);
        await ctx.audit.record({
          event: "LOGIN_FAILED",
          actorUserId: user.id,
          actorUsername: user.username,
          ip: request.ip,
          detail: { reason: "bad-password", remainingAttempts: result.remaining },
        });
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Invalid username or password" });
      }
      if (!user.active) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Account is disabled" });
      }
      const session = await ctx.sessions.create(user.id, {
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
      await ctx.users.clearFailedLogins(user.username);
      await ctx.users.setLastLogin(user.id);
      await ctx.audit.record({
        event: "LOGIN",
        actorUserId: user.id,
        actorUsername: user.username,
        ip: request.ip,
      });
      reply.setCookie(SESSION_COOKIE, session.sid, {
        httpOnly: true,
        sameSite: "strict",
        secure: ctx.localConfig.app.cookieSecure,
        path: "/",
        maxAge: ctx.localConfig.app.sessionDurationHours * 3600,
      });
      return {
        user: toPublicUser(user),
        csrfToken: session.csrfToken,
      };
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    if (request.sessionId) {
      await ctx.sessions.revoke(request.sessionId);
      // Best-effort: invalidate Guacamole tokens minted by this session so a
      // copied launch URL dies with the logout instead of lingering to the
      // Guacamole server timeout.
      try {
        let guacApi = null;
        try {
          guacApi = await ctx.getGuacApi();
        } catch {
          guacApi = null;
        }
        await ctx.guac.revokeSessionTokens(request.sessionId, guacApi);
      } catch {
        // logout must never fail because of Guacamole cleanup
      }
      await ctx.audit.record({
        event: "LOGOUT",
        actorUserId: request.user?.id ?? null,
        actorUsername: request.user?.username ?? null,
        ip: request.ip,
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/auth/change-password", async (request, reply) => {
    const user = await app.requireAuth(request);
    const body = changePasswordSchema.parse(request.body);
    const ok = await verifyPassword(user.passwordHash, body.currentPassword);
    if (!ok) {
      return reply.status(400).send({ ok: false, error: "Current password is incorrect" });
    }
    await ctx.users.changePassword(user.id, await hashPassword(body.newPassword));
    await ctx.sessions.revokeAllForUser(user.id);
    try {
      let guacApi = null;
      try {
        guacApi = await ctx.getGuacApi();
      } catch {
        guacApi = null;
      }
      await ctx.guac.revokeAllUserTokens(user.id, guacApi);
    } catch {
      // best-effort; must never fail the password change
    }
    await ctx.audit.record({
      event: "PERMISSION_CHANGED",
      actorUserId: user.id,
      actorUsername: user.username,
      detail: { action: "password_changed" },
    });
    return { ok: true };
  });
}