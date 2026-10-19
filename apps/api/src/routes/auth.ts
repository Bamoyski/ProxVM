// ---------------------------------------------------------------------------
// Auth routes: login, self-service registration, logout, password change.
// Permissions: mostly unauthenticated by design (login/register) or any
//   authenticated session (logout/change-password); no named permission gates.
// Rate limits: login 20/min/IP + 10/min/username, register 5/min/IP,
//   register-config 30/min/IP, change-password 10/min/IP + 10/min/account
//   (brute-force throttles). Register-config keys on request.ip, which the
//   trust-proxy chain resolves to the true visitor behind the tunnel, so the
//   buckets are per-client rather than one shared internet-wide pool.
// Security: uniform 401s hide user existence; dummy Argon2 equalizes timing;
//   sessions are httpOnly SameSite=strict; password changes revoke all
//   sessions + Guacamole tokens. Registration honors the self-serve mode
//   dial (closed/approval/auto) and verifies a Turnstile token whenever the
//   server has a Turnstile secret configured. Every outcome is audited.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import { alertAdmins, getSelfServeConfig, hashPassword, verifyPassword, verifyTurnstileToken, toPublicUser } from "@proxvm/core";
import { loginSchema, passwordComplexity, registrationSchema } from "@proxvm/shared";
import { SESSION_COOKIE } from "../plugins/auth.js";

// Fixed Argon2id hash (m=19456,t=2,p=1, same cost as real verifies) used only
// to equalize timing on the unknown-user login path. Not a credential.
const DUMMY_TIMING_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$mlVrf1gpnLB8krhX/navaw$2io4mZnn1EEPLTkKmGuXFuoOtG2ZOEwFGqRs3BNBrME";

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: passwordComplexity,
});

/**
 * Register login/register/logout/change-password endpoints on the app.
 * WHY a single group: all four share session-cookie + audit conventions,
 * so keeping them together keeps the auth security posture reviewable.
 */
export async function authRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  // -- Login (throttled, enumeration-hardened) -------------------------------
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
      // Enumeration-hardened: every failure below returns the identical 401
      // code/message. Lockout, disablement, and nonexistence are recorded
      // with distinct audit reasons (threat detection reads those; attackers
      // only see the uniform response). Unknown users still burn one Argon2
      // verify against a fixed dummy hash so timing matches the bad-password
      // path.
      const GENERIC_FAILURE = "Invalid username or password";
      const user = await ctx.users.findByUsername(body.username);
      if (!user) {
        await verifyPassword(DUMMY_TIMING_HASH, body.password);
        await app.audit(request, {
          event: "LOGIN_FAILED",
          actorUsername: body.username,
          detail: { reason: "unknown-user" },
        });
        return reply.status(401).send({ code: "UNAUTHORIZED", message: GENERIC_FAILURE });
      }
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        await app.audit(request, {
          event: "LOGIN_FAILED",
          actorUserId: user.id,
          actorUsername: user.username,
          detail: { reason: "account-locked" },
        });
        return reply.status(401).send({ code: "UNAUTHORIZED", message: GENERIC_FAILURE });
      }
      const valid = await verifyPassword(user.passwordHash, body.password);
      if (!valid) {
        const result = await ctx.users.recordFailedLogin(body.username, 5, 15);
        await app.audit(request, {
          event: "LOGIN_FAILED",
          actorUserId: user.id,
          actorUsername: user.username,
          ip: request.ip,
          detail: { reason: "bad-password", remainingAttempts: result.remaining },
        });
        return reply.status(401).send({ code: "UNAUTHORIZED", message: GENERIC_FAILURE });
      }
      if (!user.active) {
        await app.audit(request, {
          event: "LOGIN_FAILED",
          actorUserId: user.id,
          actorUsername: user.username,
          detail: { reason: "account-disabled" },
        });
        return reply.status(401).send({ code: "UNAUTHORIZED", message: GENERIC_FAILURE });
      }
      const session = await ctx.sessions.create(user.id, {
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
      await ctx.users.clearFailedLogins(user.username);
      // Never downgrade: configured Secure wins, otherwise upgrade when the
      // request itself arrived over TLS (request.protocol honors
      // X-Forwarded-Proto only from trusted proxy hops, else the socket).
      const secureCookie = ctx.localConfig.app.cookieSecure || request.protocol === "https";
      await ctx.users.setLastLogin(user.id);
      await app.audit(request, {
        event: "LOGIN",
        actorUserId: user.id,
        actorUsername: user.username,
        ip: request.ip,
      });
      reply.setCookie(SESSION_COOKIE, session.sid, {
        httpOnly: true,
        sameSite: "strict",
        secure: secureCookie,
        path: "/",
        maxAge: ctx.localConfig.app.sessionDurationHours * 3600,
      });
      return {
        user: toPublicUser(user),
        csrfToken: session.csrfToken,
      };
    },
  );

  // Public signup configuration for the login page. Unauthenticated by
  // design; only shapes that are already public on their own (the mode
  // choice, the Turnstile SITE key — public as part of the widget). The
  // secret never appears here.
  app.get(
    "/auth/register-config",
    { config: { csrf: "skip", rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async () => {
      const cfg = await getSelfServeConfig(ctx.settings);
      return {
        mode: cfg.mode,
        turnstileSiteKey: cfg.turnstileSiteKey,
      };
    },
  );

  // Self-service account request. Unauthenticated by design; tightly
  // rate-limited (bots) and inert until an administrator approves it.
  // Duplicate usernames (accounts or pending requests) get a 409.
  app.post(
    "/auth/register",
    {
      config: { csrf: "skip", rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = registrationSchema.parse(request.body);
      const selfServe = await getSelfServeConfig(ctx.settings);
      if (selfServe.mode === "closed") {
        return reply.status(403).send({
          code: "REGISTRATION_CLOSED",
          message: "Registration is closed. Ask an administrator to create an account.",
        });
      }
      // Fail closed on the bot gate: a configured secret makes the token
      // mandatory, and a missing/misused token is a 4xx, never a queue entry.
      if (selfServe.turnstileSecret) {
        if (!body.turnstileToken) {
          return reply.status(400).send({
            code: "TURNSTILE_REQUIRED",
            message: "Please complete the verification challenge.",
          });
        }
        const human = await verifyTurnstileToken(selfServe.turnstileSecret, body.turnstileToken, request.ip);
        if (!human) {
          return reply.status(400).send({
            code: "TURNSTILE_FAILED",
            message: "Verification failed. Please try the challenge again.",
          });
        }
      }
      const passwordHash = await hashPassword(body.password);

      // AUTO: create instantly with the zero-permission GUEST role. The
      // handler computed the effective mode (auto degrades to approval
      // without a Turnstile secret) and every user just created here is
      // audited + announced so escalation stays a human decision.
      if (selfServe.mode === "auto") {
        try {
          const user = await ctx.users.create({
            username: body.username,
            email: body.email,
            passwordHash,
            roles: ["GUEST"],
          });
          await app.audit(request, {
            event: "USER_CREATED",
            actorUsername: body.username,
            ip: request.ip,
            detail: { selfServe: true, roles: ["GUEST"], username: body.username },
          });
          await alertAdmins(ctx.db, ctx.settings, ctx.logger, {
            kind: "user",
            title: `New self-serve account: ${body.username}`,
            body: "Auto-approved into GUEST (no VM access). Grant roles from the Users page when you vet them.",
            link: "/users",
          });
          return reply.status(201).send({ ok: true, autoApproved: true });
        } catch (err) {
          if ((err as { code?: string })?.code === "23505" || (err as { code?: string })?.code === "CONFLICT") {
            return reply.status(409).send({ code: "CONFLICT", message: "Username already exists or has a pending request" });
          }
          throw err;
        }
      }

      try {
        const created = await ctx.registration.request({
          username: body.username,
          email: body.email,
          passwordHash,
        });
        await app.audit(request, {
          event: "REGISTRATION_REQUESTED",
          actorUsername: body.username,
          ip: request.ip,
          detail: { username: body.username },
        });
        // Best-effort admin delivery: the request row is authoritative.
        // alertAdmins writes the in-app bell row and pushes to Gotify,
        // and never throws.
        await alertAdmins(ctx.db, ctx.settings, ctx.logger, {
          kind: "registration",
          title: `New account request: ${body.username}`,
          body: "Review and approve or reject it from the Users page.",
          link: "/users",
        });
        return reply.status(201).send({ ok: true, id: created.id });
      } catch (err) {
        if ((err as { code?: string })?.code === "CONFLICT") {
          return reply.status(409).send({ code: "CONFLICT", message: "Username already exists or has a pending request" });
        }
        throw err;
      }
    },
  );

  // -- Logout (session + Guacamole cleanup) -------------------------------
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
      await app.audit(request, {
        event: "LOGOUT",
        actorUserId: request.user?.id ?? null,
        actorUsername: request.user?.username ?? null,
        ip: request.ip,
      });
    }
    // Mirror the login attributes so strict browsers actually drop the cookie.
    reply.clearCookie(SESSION_COOKIE, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: ctx.localConfig.app.cookieSecure || request.protocol === "https",
    });
    return { ok: true };
  });

  // -- Password change (session-bound, throttled) -------------------------
  app.post(
    "/auth/change-password",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = await app.requireAuth(request);
      // Per-account throttle on top of the per-IP route limit: distributed
      // IPs must not grind currentPassword against a stolen session.
      try {
        const key = `proxvm:password-change-throttle:${user.id}`;
        const attempts = await ctx.redis.incr(key);
        if (attempts === 1) await ctx.redis.expire(key, 60);
        if (attempts > 10) {
          return reply.status(429).send({ ok: false, error: "Too many password attempts. Please slow down." });
        }
      } catch (err) {
        ctx.logger.warn({ error: err instanceof Error ? err.message : String(err) }, "password-change throttle unavailable; continuing");
      }
    const body = changePasswordSchema.parse(request.body);
    const ok = await verifyPassword(user.passwordHash, body.currentPassword);
    if (!ok) {
      await app.audit(request, {
        event: "PERMISSION_CHANGED",
        actorUserId: user.id,
        actorUsername: user.username,
        detail: { action: "password_change_failed", reason: "bad-current-password" },
      });
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
    await app.audit(request, {
      event: "PERMISSION_CHANGED",
      actorUserId: user.id,
      actorUsername: user.username,
      detail: { action: "password_changed" },
    });
    return { ok: true };
    },
  );
}