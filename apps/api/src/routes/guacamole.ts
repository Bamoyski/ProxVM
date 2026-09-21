import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import {
  allowedProtocols,
  AppError,
  checkAccess,
  resolveEffectiveAccess,
} from "@proxvm/core";

export async function guacamoleRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  app.get("/guacamole/connections", async (request) => {
    const user = await app.requireAuth(request);
    const privileged = user.roles.some((r) => r === "ADMIN" || r === "OPERATOR");
    const vms = privileged ? await ctx.vms.list() : await ctx.vms.listAssignedToUser(user.id);
    const connections = [];
    for (const vm of vms) {
      const records = await ctx.guac.listConnectionRecords(vm.id);
      for (const record of records) {
        connections.push({
          id: record.id,
          vmId: record.vm_id,
          vmName: vm.name,
          vmid: vm.vmid,
          node: vm.node,
          protocol: record.protocol,
          hostname: record.hostname,
          port: record.port,
          username: record.username,
          status: record.status,
          guacConnectionName: record.guac_connection_name,
          guacIdentifier: record.guac_identifier,
          lastVerifiedAt: record.last_verified_at,
          createdAt: record.created_at,
        });
      }
    }
    return { connections };
  });

  const launchSchema = z.object({
    protocol: z.enum(["ssh", "rdp", "vnc"]).optional(),
  });

  app.post("/vms/:id/guacamole/launch", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("guac.launch")(request);
    const body = launchSchema.parse(request.body ?? {});
    const privileged = user.roles.some((r) => r === "ADMIN" || r === "OPERATOR");
    // Privileged users bypass VM-access checks exactly as before; everyone
    // else goes through the IAM engine (direct + group access, expiry,
    // protocol scoping).
    let effectiveProtocols: string[] | null = null;
    if (!privileged) {
      const verdict = await checkAccess(ctx.db, user, { vmId: id, protocol: body.protocol });
      if (!verdict.allowed) {
        if (verdict.reason === "access_expired") {
          // Self-cleaning: drop stale Guacamole permissions and the expired
          // direct row so the next attempt is a clean deny.
          try {
            await ctx.guac.revokeVmAccess(id, user.id, await ctx.getGuacDb());
          } catch {
            // best-effort; the periodic sweep retries later
          }
          await ctx.vms.revokeAccess(id, user.id);
          await ctx.audit.record({
            event: "TEMPORARY_ACCESS_EXPIRED",
            actorUserId: user.id,
            actorUsername: user.username,
            vmId: id,
            detail: { during: "launch" },
          });
        }
        throw AppError.forbidden("You do not have permission to launch this Guacamole connection").withDetails({
          allowed: false,
          reason: verdict.reason,
          permission: "guac.launch",
        });
      }
      effectiveProtocols = allowedProtocols(await resolveEffectiveAccess(ctx.db, user.id), id);
    }
    const vm = await ctx.vms.requireById(id);
    const guacDb = await ctx.getGuacDb();
    await ctx.guac.ensureGuacUser(user.id, user.username, guacDb);
    await ctx.guac.grantVmAccess(vm.id, user.id, guacDb);
    const records = await ctx.guac.listConnectionRecords(vm.id);
    const usable =
      privileged || effectiveProtocols === null
        ? records
        : records.filter((r) => (effectiveProtocols as string[]).includes(r.protocol));
    if (body.protocol && !usable.some((r) => r.protocol === body.protocol)) {
      if (!records.length) throw AppError.notFound("No Guacamole connection exists for this VM");
      throw AppError.notFound(
        `No Guacamole connection exists for this VM for the permitted protocol(s): ${usable.map((r) => r.protocol).join(", ") || "none"}`,
      );
    }
    if (!usable.length) throw AppError.notFound("No Guacamole connection exists for this VM");
    const resolvedProtocol = body.protocol ?? usable[0]!.protocol;
    const guacApi = await ctx.getGuacApi();
    const guacSettings = await ctx.settings.guacamole();
    const result = await ctx.guac.launch(vm.id, user.id, guacApi, guacSettings?.url ?? "", guacSettings?.publicUrl ?? null, resolvedProtocol, {
      trackSessionId: request.sessionId ?? undefined,
    });
    if (result.mode === "login") {
      // Server-side only: the user-facing detail is intentionally generic.
      ctx.logger.warn(
        { vmId: vm.id, userId: user.id, guacUrl: guacSettings?.url ?? null, detail: result.detail ?? null },
        "guacamole direct launch unavailable; falling back to login page",
      );
    }
    await ctx.audit.record({
      event: "GUAC_LAUNCHED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { mode: result.mode, detail: result.detail ?? null, protocol: resolvedProtocol },
    });
    return result;
  });

  // Diagnostic only: tests one stored connection (TCP always; SSH auth with
  // the stored credential; RDP handshake liveness) without revealing any
  // secret. Requires VM access like the credential endpoints, so holders of
  // vm.read on an assigned VM can self-diagnose "internal error" launches.
  app.post("/vms/:id/guacamole/test", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("vm.read")(request);
    const privileged = user.roles.some((r) => r === "ADMIN" || r === "OPERATOR");
    if (!privileged && !(await ctx.vms.hasAccess(id, user.id))) {
      throw AppError.forbidden("No access to this VM");
    }
    const body = launchSchema.parse(request.body ?? {});
    return ctx.guac.testConnectionRecord(id, body.protocol);
  });

  app.delete("/guacamole/connections/:vmId", async (request) => {
    const user = await app.requirePermission("guac.manage")(request);
    const { vmId } = request.params as { vmId: string };
    const vm = await ctx.vms.requireById(vmId);
    const body = z.object({ confirmText: z.string().min(1) }).parse(request.body);
    if (body.confirmText !== `DELETE ${vm.name}`) {
      throw AppError.validation(`Confirmation text must be exactly: DELETE ${vm.name}`);
    }
    const guacDb = await ctx.getGuacDb();
    await ctx.guac.deleteVmResources(vm.id, guacDb);
    await ctx.audit.record({
      event: "GUAC_CONNECTION_DELETED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { vmName: vm.name },
    });
    return { ok: true };
  });
}