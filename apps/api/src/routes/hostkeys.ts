import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import { AppError, normalizeFingerprint } from "@proxvm/core";

const endpointSchema = z.object({
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

const rotateSchema = endpointSchema.extend({
  fingerprint: z.string().min(1),
});

/**
 * SSH host-key trust management. Pinning is automatic (TOFU on first
 * authenticated connection); these routes let an administrator inspect pins
 * and, after confirming a legitimate change out-of-band, re-verify or clear a
 * pin. Every mutation is audited by HostKeyService.
 */
export async function hostKeyRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  const vmHostOrThrow = (vm: { ipAddress: string | null }, override?: string, port?: number) => {
    const host = override ?? vm.ipAddress;
    if (!host) {
      throw AppError.validation("This VM has no IP address; provide the host parameter explicitly.");
    }
    return { host, port: port ?? 22 };
  };

  app.get("/vms/:id/host-keys", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("vm.read")(request);
    const { allowed } = await ctx.vms.visibleTo(user.id, user.roles, id);
    if (!allowed) throw AppError.forbidden("No access to this VM");
    const pins = await ctx.hostKeys.listForVm(id);
    return {
      hostKeys: pins.map((p) => ({
        endpoint: p.endpoint,
        fingerprint: p.fingerprint,
        keyType: p.keyType,
        enrolledAt: p.enrolledAt,
        updatedAt: p.updatedAt,
      })),
    };
  });

  app.post("/vms/:id/host-keys/rotate", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requireAdmin(request);
    const vm = await ctx.vms.requireById(id);
    const body = rotateSchema.parse(request.body ?? {});
    const fingerprint = normalizeFingerprint(body.fingerprint);
    if (!fingerprint) {
      throw AppError.validation(
        'fingerprint must be a 64-character hex sha256 value or an OpenSSH-formatted "SHA256:..." value',
      );
    }
    const { host, port } = vmHostOrThrow(vm, body.host, body.port);
    const updated = await ctx.hostKeys.setFingerprint({
      vmId: vm.id,
      host,
      port,
      fingerprint,
      actorUserId: user.id,
      actorUsername: user.username,
    });
    if (!updated) {
      throw AppError.notFound(
        "No SSH host key is pinned for that VM endpoint yet; let a connection enroll one before rotating.",
      );
    }
    return {
      endpoint: updated.endpoint,
      fingerprint: updated.fingerprint,
      keyType: updated.keyType,
      updatedAt: updated.updatedAt,
    };
  });

  app.post("/vms/:id/host-keys/unpin", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requireAdmin(request);
    const vm = await ctx.vms.requireById(id);
    const body = endpointSchema.parse(request.body ?? {});
    const { host, port } = vmHostOrThrow(vm, body.host, body.port);
    const removed = await ctx.hostKeys.unpin({
      vmId: vm.id,
      host,
      port,
      actorUserId: user.id,
      actorUsername: user.username,
    });
    return { removed };
  });
}