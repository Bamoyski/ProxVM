// ---------------------------------------------------------------------------
// Guacamole routes: connection inventory, health snapshots, per-VM launch,
//   connection test, connection deletion.
// Permissions: inventory/health need any session (privacy-filtered);
//   launch needs guac.launch + VM visibility + protocol grant; test needs
//   vm.read + visibility; delete needs guac.manage.
// Rate limits: none on management paths (launch is user-initiated demand and
//   auto-starts stopped VMs, so abuse shows up as audited power events).
// Security: launch tokens are no-store; expired grants self-clean; protocol
//   scoping is enforced server-side from effective access, never the client.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import { passwordComplexity } from "@proxvm/shared";
import {
  alertAdmins,
  allowedProtocols,
  AppError,
  checkAccess,
  listConnectionHealth,
  resolveEffectiveAccess,
  startVmForLaunchIfStopped,
} from "@proxvm/core";

/**
 * Register Guacamole inventory/launch/test/delete endpoints.
 * WHY visibility-first: every path re-checks VM visibility so privacy-flagged
 * VMs never leak connection metadata to ungranted privileged list callers.
 */
export async function guacamoleRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  app.get("/guacamole/connections", async (request) => {
    const user = await app.requireAuth(request);
    const privileged = user.roles.some((r) => r === "ADMIN" || r === "OPERATOR");
    const vms = privileged ? await ctx.vms.list() : await ctx.vms.listAssignedToUser(user.id);
    const connections = [];
    for (const vm of vms) {
      // Privacy-flagged VMs stay invisible without a concrete grant.
      if (privileged && vm.privacyFlag && !(await ctx.vms.hasAccessOrOwns(vm.id, user.id))) continue;
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

  // Latest health snapshots per VM+protocol (written by the periodic checker).
  // Same visibility as the connections list; the VM detail Test button covers
  // on-demand checks.
  app.get("/connection-health", async (request) => {
    const user = await app.requireAuth(request);
    const privileged = user.roles.some((r) => r === "ADMIN" || r === "OPERATOR");
    let vms = privileged ? await ctx.vms.list() : await ctx.vms.listAssignedToUser(user.id);
    if (privileged) {
      const visible = [];
      for (const vm of vms) {
        if (!vm.privacyFlag || (await ctx.vms.hasAccessOrOwns(vm.id, user.id))) visible.push(vm);
      }
      vms = visible;
    }
    const health = await listConnectionHealth(
      ctx.db,
      vms.map((vm) => vm.id).filter((id): id is string => id !== null),
    );
    return { health };
  });

  app.post("/vms/:id/guacamole/launch", async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("guac.launch")(request);
    const body = launchSchema.parse(request.body ?? {});
    const privileged = user.roles.some((r) => r === "ADMIN" || r === "OPERATOR");
    // Privileged users bypass VM-access checks exactly as before — EXCEPT on
    // privacy-flagged VMs, where everyone needs a concrete grant.
    const visibility = await ctx.vms.visibleTo(user.id, user.roles, id);
    let effectiveProtocols: string[] | null = null;
    if (!privileged || visibility.private) {
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
          await app.audit(request, {
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
      effectiveProtocols === null
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

    // A session launch is an authorized, user-initiated demand for the VM.
    // Check live Proxmox state (rather than stale local status) and start a
    // stopped VM before handing Guacamole a connection URL.
    const autoStarted = await startVmForLaunchIfStopped(await ctx.getProxmoxClient(), vm);
    if (autoStarted) {
      await ctx.vms.updateStatus(vm.id, "running");
      await app.audit(request, {
        event: "VM_AUTO_STARTED",
        actorUserId: user.id,
        actorUsername: user.username,
        vmId: vm.id,
        detail: { reason: "guacamole_launch", protocol: resolvedProtocol },
      });
    }
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
    await app.audit(request, {
      event: "GUAC_LAUNCHED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { mode: result.mode, detail: result.detail ?? null, protocol: resolvedProtocol, autoStarted },
    });
    // The payload can carry a reusable Guacamole session token: never let
    // intermediaries or disk caches store it.
    reply.header("Cache-Control", "no-store");
    return result;
  });

  // Diagnostic only: tests one stored connection (TCP always; SSH auth with
  // the stored credential; RDP handshake liveness) without revealing any
  // secret. Requires VM access like the credential endpoints, so holders of
  // vm.read on an assigned VM can self-diagnose "internal error" launches.
  app.post("/vms/:id/guacamole/test", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("vm.read")(request);
    const { allowed } = await ctx.vms.visibleTo(user.id, user.roles, id);
    if (!allowed) {
      throw AppError.forbidden("No access to this VM");
    }
    const body = launchSchema.parse(request.body ?? {});
    return ctx.guac.testConnectionRecord(id, body.protocol);
  });

  app.delete("/guacamole/connections/:vmId", async (request) => {
    const user = await app.requirePermission("guac.manage")(request);
    const { vmId } = request.params as { vmId: string };
    const vm = await ctx.vms.requireById(vmId);
    if (vm.privacyFlag && !(await ctx.vms.hasAccessOrOwns(vm.id, user.id))) {
      throw AppError.forbidden("This VM is privacy-flagged and you have no grant for it");
    }
    const body = z.object({ confirmText: z.string().min(1) }).parse(request.body);
    if (body.confirmText !== `DELETE ${vm.name}`) {
      throw AppError.validation(`Confirmation text must be exactly: DELETE ${vm.name}`);
    }
    const guacDb = await ctx.getGuacDb();
    await ctx.guac.deleteVmResources(vm.id, guacDb);
    await app.audit(request, {
      event: "GUAC_CONNECTION_DELETED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { vmName: vm.name },
    });
    return { ok: true };
  });

  // -- Direct Guacamole logins (opt-in per user, admin-managed) --------------
  // Most users only enter Guacamole through ProxVM's token-minting launch
  // with a random unknown password. These endpoints let an admin give a
  // specific user a KNOWN password so they can sign in at the Guacamole web
  // UI directly (scaling = repeat per user). Write-only: the password is
  // never returned or logged. Disabling rotates back to random unknown.
  // Direct sessions bypass ProxVM launch audit/policies, so every change is
  // audited AND paged to admins; Guac-side connection permissions still apply.
  app.get("/guacamole/users/:id/direct-login", async (request) => {
    await app.requirePermission("users.manage")(request);
    const { id } = request.params as { id: string };
    const target = await ctx.users.findById(id);
    if (!target) throw AppError.notFound("User not found");
    const record = await ctx.guac.findUserRecord(id);
    return {
      userId: id,
      username: target.username,
      guacUsername: record?.guac_username ?? null,
      directLoginEnabled: record?.direct_login_enabled ?? false,
      directLoginSetAt: record?.direct_login_set_at ?? null,
    };
  });

  app.post(
    "/guacamole/users/:id/direct-login",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request) => {
      const actor = await app.requirePermission("users.manage")(request);
      const { id } = request.params as { id: string };
      const target = await ctx.users.findById(id);
      if (!target) throw AppError.notFound("User not found");
      const body = z.object({ password: passwordComplexity }).parse(request.body);
      const record = await ctx.guac.setGuacDirectLoginPassword(id, target.username, body.password, await ctx.getGuacDb());
      await app.audit(request, {
        event: "GUAC_DIRECT_LOGIN_ENABLED",
        actorUserId: actor.id,
        actorUsername: actor.username,
        detail: { targetUserId: id, targetUsername: target.username, guacUsername: record.guac_username },
      });
      await alertAdmins(ctx.db, ctx.settings, ctx.logger, {
        kind: "user",
        title: `Direct Guacamole login enabled for ${target.username}`,
        body: `${actor.username} set a known Guacamole password for ${target.username} (${record.guac_username}). Their direct sessions bypass ProxVM launch audit.`,
        link: "/users",
      });
      return { ok: true, guacUsername: record.guac_username };
    },
  );

  app.delete("/guacamole/users/:id/direct-login", async (request) => {
    const actor = await app.requirePermission("users.manage")(request);
    const { id } = request.params as { id: string };
    const target = await ctx.users.findById(id);
    if (!target) throw AppError.notFound("User not found");
    const record = await ctx.guac.disableGuacDirectLogin(id, await ctx.getGuacDb());
    if (!record) throw AppError.notFound("User has no Guacamole account yet");
    await app.audit(request, {
      event: "GUAC_DIRECT_LOGIN_DISABLED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { targetUserId: id, targetUsername: target.username, guacUsername: record.guac_username },
    });
    await alertAdmins(ctx.db, ctx.settings, ctx.logger, {
      kind: "user",
      title: `Direct Guacamole login disabled for ${target.username}`,
      body: `${actor.username} rotated ${target.username} (${record.guac_username}) back to a random unknown password.`,
      link: "/users",
    });
    return { ok: true };
  });
}
