import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import { AppError, generatePassword } from "@proxvm/core";
import { credentialRotateSchema } from "@proxvm/shared";

const REVEAL_DISPLAY = "••••••••••••••••••";

export async function credentialRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  const resolveAccess = async (request: Parameters<typeof app.requireAuth>[0], vmId: string) => {
    const user = await app.requireAuth(request);
    const { allowed } = await ctx.vms.visibleTo(user.id, user.roles, vmId);
    return { user, allowed };
  };

  app.get("/vms/:id/credentials", async (request) => {
    const { id } = request.params as { id: string };
    const access = await resolveAccess(request, id);
    if (!access.allowed) throw AppError.forbidden();
    const vm = await ctx.vms.requireById(id);
    const cred = await ctx.creds.view(vm.id);
    return {
      credential: cred
        ? { ...cred, password: REVEAL_DISPLAY, hasPassword: true }
        : { password: REVEAL_DISPLAY, hasPassword: false },
    };
  });

  app.post("/vms/:id/credentials/reveal", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("cred.reveal")(request);
    const access = await resolveAccess(request, id);
    if (!access.allowed) throw AppError.forbidden("No access to this VM");
    const vm = await ctx.vms.requireById(id);
    const row = await ctx.creds.findByVm(vm.id);
    if (!row) throw AppError.notFound("No credential stored for this VM");
    const password = ctx.decrypt(row.password_ciphertext);
    await ctx.audit.record({
      event: "PASSWORD_REVEALED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { username: row.username },
    });
    return { password, username: row.username, autoHideSeconds: 30 };
  });

  app.post("/vms/:id/credentials/copy", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("cred.reveal")(request);
    const access = await resolveAccess(request, id);
    if (!access.allowed) throw AppError.forbidden("No access to this VM");
    const vm = await ctx.vms.requireById(id);
    const row = await ctx.creds.findByVm(vm.id);
    if (!row) throw AppError.notFound("No credential stored for this VM");
    const password = ctx.decrypt(row.password_ciphertext);
    await ctx.audit.record({
      event: "PASSWORD_COPIED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { username: row.username },
    });
    return { password, username: row.username };
  });

  app.post("/vms/:id/credentials/rotate", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("cred.rotate")(request);
    const access = await resolveAccess(request, id);
    if (!access.allowed) throw AppError.forbidden("No access to this VM");
    const vm = await ctx.vms.requireById(id);
    const body = credentialRotateSchema.parse(request.body ?? {});
    const result = await ctx.rotateCredential(
      vm.id,
      { newPassword: body.newPassword, username: body.username, verify: body.verify },
      { userId: user.id, username: user.username },
    );
    return result;
  });

  app.post("/vms/:id/credentials/generate", async (request) => {
    await app.requireAuth(request);
    return { password: generatePassword(24) };
  });

  app.post("/credentials/generate", async (request) => {
    await app.requireAuth(request);
    return { password: generatePassword(24) };
  });

  app.get("/credentials", async (request) => {
    await app.requirePermission("cred.reveal")(request);
    const vms = await ctx.vms.list();
    const entries = [];
    for (const vm of vms) {
      const cred = await ctx.creds.view(vm.id);
      if (!cred) continue;
      entries.push({
        vmId: vm.id,
        vmName: vm.name,
        vmid: vm.vmid,
        node: vm.node,
        username: cred.username,
        status: cred.status,
        createdAt: cred.createdAt,
        lastVerifiedAt: cred.lastVerifiedAt,
        lastRotatedAt: cred.lastRotatedAt,
      });
    }
    return { credentials: entries };
  });
}
