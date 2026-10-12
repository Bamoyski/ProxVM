// ---------------------------------------------------------------------------
// Templates routes: list registered provisioning templates, register a new
//   template against a live Proxmox template, delete with typed confirmation.
// Permissions: list needs any session (provisioning UX); register/delete
//   need templates.manage (ADMIN/operator surface).
// Rate limits: none (management-only writes; each is audited).
// Security: registration verifies the vmid+node exists live in Proxmox so
//   jobs cannot point at phantom templates; deletes need DELETE <name>.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import { AppError } from "@proxvm/core";
import { PROVISIONING_METHODS, OS_TYPES, PROTOCOLS } from "@proxvm/shared";

const registerSchema = z.object({
  name: z.string().min(1).max(128),
  node: z.string().min(1).max(128),
  proxmoxVmid: z.number().int().min(100),
  osType: z.enum(OS_TYPES),
  provisioningMethod: z.enum(PROVISIONING_METHODS),
  cloudInitSupport: z.boolean(),
  guestAgentRequired: z.boolean().default(true),
  defaultCpu: z.number().int().min(1).max(512).default(2),
  defaultRamMb: z.number().int().min(256).max(1048576).default(2048),
  defaultDiskGb: z.number().min(1).max(16384).default(20),
  supportedProtocols: z.array(z.enum(PROTOCOLS)).min(1).default(["ssh"]),
});

/**
 * Register template list/register/delete endpoints.
 * WHY live verification on register: the provisioning pipeline clones by
 * vmid, so a typo would otherwise surface only mid-job as an orphaned VM.
 */
export async function templateRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  // -- List (any session; provisioning UX needs it) --------------------------
  app.get("/templates", { preHandler: app.requireAuth }, async () => {
    return { templates: await ctx.templates.list() };
  });

  // -- Register/delete (templates.manage, audited) ---------------------------
  app.post("/templates", async (request) => {
    const actor = await app.requirePermission("templates.manage")(request);
    const body = registerSchema.parse(request.body);
    const client = await ctx.getProxmoxClient();
    const proxmoxTemplates = await client.templates();
    const exists = proxmoxTemplates.some(
      (t) => Number(t.vmid) === body.proxmoxVmid && String(t.node) === body.node,
    );
    if (!exists) {
      throw AppError.external(
        "Proxmox",
        `No Proxmox template with VMID ${body.proxmoxVmid} exists on node ${body.node}. Discovered templates: ${proxmoxTemplates
          .map((t) => `${t.node}/${t.vmid}`)
          .join(", ") || "none"}`,
      );
    }
    const template = await ctx.templates.register(body);
    await app.audit(request, {
      event: "TEMPLATE_CREATED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { name: body.name, vmid: body.proxmoxVmid, node: body.node },
    });
    return { template };
  });

  app.delete("/templates/:id", async (request) => {
    const actor = await app.requirePermission("templates.manage")(request);
    const { id } = request.params as { id: string };
    const template = await ctx.templates.requireById(id);
    const body = z.object({ confirmText: z.string().min(1) }).parse(request.body);
    if (body.confirmText !== `DELETE ${template.name}`) {
      throw AppError.validation(`Confirmation text must be exactly: DELETE ${template.name}`);
    }
    await ctx.templates.delete(id);
    await app.audit(request, {
      event: "TEMPLATE_DELETED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { name: template.name },
    });
    return { ok: true };
  });
}
