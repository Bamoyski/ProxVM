import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import {
  assertCanAdministerTarget,
  assertMayConfer,
  hashPassword,
  ROLE_IDS,
  roleEffectivePermissions,
  toPublicUser,
} from "@proxvm/core";
import { createUserSchema } from "@proxvm/shared";

const updateUserSchema = z.object({
  active: z.boolean().optional(),
  role: z.enum(["ADMIN", "OPERATOR", "USER"]).optional(),
  password: z
    .string()
    .min(12)
    .regex(/[a-z]/)
    .regex(/[A-Z]/)
    .regex(/[0-9]/)
    .regex(/[^A-Za-z0-9]/)
    .optional(),
  email: z.string().email().optional(),
  givenName: z.string().max(128).optional(),
});

export async function usersRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;
  const guard = app.requirePermission("users.manage");

  app.get("/users", async (request) => {
    await guard(request);
    const users = await ctx.users.list();
    return { users: users.map(toPublicUser) };
  });

  app.post("/users", async (request, reply) => {
    const actor = await guard(request);
    const body = createUserSchema.parse(request.body);
    const existing = await ctx.users.findByUsername(body.username);
    if (existing) {
      return reply.status(409).send({ code: "CONFLICT", message: "Username already exists" });
    }
    // Creating a user with a role confers that role's permissions.
    await assertMayConfer(ctx.db, actor, await roleEffectivePermissions(ctx.db, ROLE_IDS[body.role]));
    const user = await ctx.users.create({
      username: body.username,
      email: body.email,
      givenName: body.givenName,
      passwordHash: await hashPassword(body.password),
      roles: [body.role],
    });
    // Guacamole account provisioning is best-effort: if Guacamole is down or
    // unconfigured, the user is still created and the account is provisioned
    // lazily on first Guacamole launch (which always calls ensureGuacUser).
    // Failing the whole request here would leave a half-created user behind
    // and block retries with a misleading 409 conflict.
    let guacSynced = true;
    let guacError: string | null = null;
    try {
      await ctx.guac.ensureGuacUser(user.id, user.username, await ctx.getGuacDb());
    } catch (err) {
      guacSynced = false;
      guacError = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(
        { targetUserId: user.id, username: user.username, error: guacError },
        "user created but Guacamole account provisioning deferred",
      );
    }
    await ctx.audit.record({
      event: "USER_CREATED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { username: body.username, role: body.role, guacSynced, ...(guacError ? { guacError } : {}) },
    });
    return { user: toPublicUser(user), guacSynced };
  });

  app.put("/users/:id", async (request, reply) => {
    const actor = await guard(request);
    const { id } = request.params as { id: string };
    const body = updateUserSchema.parse(request.body);
    const target = await ctx.users.findById(id);
    if (!target) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "User not found" });
    }
    // No operating upward: password resets, deactivation, role changes and
    // profile edits on users holding permissions the actor lacks are denied.
    await assertCanAdministerTarget(ctx.db, actor, id);
    if (body.active !== undefined && body.active === false) {
      if (target.id === actor.id) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: "You cannot disable your own account" });
      }
      if (await ctx.users.isInitialAdmin(target.id)) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: "The initial administrator account cannot be disabled.",
        });
      }
      if (!(await ctx.users.canDeactivate(target.id))) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: `Cannot disable "${target.username}": they are the only active administrator. Create or promote another administrator first.`,
        });
      }
      await ctx.users.setActive(target.id, body.active);
      await ctx.sessions.revokeAllForUser(target.id);
    } else if (body.active === true) {
      await ctx.users.setActive(target.id, true);
    }
    if (body.role) {
      if (target.id === actor.id && body.role !== "ADMIN") {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: "You cannot demote your own account" });
      }
      await assertMayConfer(ctx.db, actor, await roleEffectivePermissions(ctx.db, ROLE_IDS[body.role]));
      try {
        await ctx.users.setRolesGuarded(target.id, [body.role]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: msg });
      }
    }
    if (body.password) {
      await ctx.users.changePassword(target.id, await hashPassword(body.password));
      await ctx.sessions.revokeAllForUser(target.id);
    }
    if (body.email !== undefined || body.givenName !== undefined) {
      await ctx.db.query(
        "UPDATE users SET email = COALESCE($2, email), given_name = COALESCE($3, given_name), updated_at = NOW() WHERE id = $1",
        [target.id, body.email ?? null, body.givenName ?? null],
      );
    }
    await ctx.audit.record({
      event: "PERMISSION_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: {
        targetUser: target.username,
        active: body.active,
        role: body.role,
        passwordReset: body.password !== undefined,
      },
    });
    const updated = await ctx.users.findById(target.id);
    return { user: updated ? toPublicUser(updated) : null };
  });

  app.delete("/users/:id", async (request, reply) => {
    const actor = await guard(request);
    const { id } = request.params as { id: string };
    if (id === actor.id) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "You cannot delete your own account" });
    }
    const target = await ctx.users.findById(id);
    if (!target) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "User not found" });
    }
    await assertCanAdministerTarget(ctx.db, actor, id);
    try {
      const guacDb = await ctx.getGuacDb();
      await ctx.guac.removeUserResources(target.id, guacDb);
    } catch {
      // Guacamole cleanup is best-effort; the app user is still removed.
    }
    try {
      await ctx.users.deleteGuarded(target.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: msg });
    }
    await ctx.audit.record({
      event: "USER_DELETED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { username: target.username },
    });
    return { ok: true };
  });
}
