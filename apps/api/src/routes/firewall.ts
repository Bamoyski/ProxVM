import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import {
  AppError,
  applyIsolation,
  assertFirewallRuleInput,
  getIsolationStatus,
  isProxvmRule,
  removeIsolation,
} from "@proxvm/core";

// Per-VM network isolation ("default deny") via the Proxmox guest firewall.
// Opt-in per VM; never touches datacenter/node/host config. The backend is
// authoritative — the UI only renders what these endpoints return.

function guacdHostFromSettings(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.trim().toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

export async function firewallRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  app.get("/vms/:id/firewall", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("vm.read")(request);
    const { allowed } = await ctx.vms.visibleTo(user.id, user.roles, id);
    if (!allowed) throw AppError.forbidden("No access to this VM");
    const vm = await ctx.vms.requireById(id);
    const proxmox = await ctx.getProxmoxClient();
    const status = await getIsolationStatus(proxmox, vm.node, vm.vmid);
    const guacSettings = await ctx.settings.guacamole();
    return {
      isolated: vm.firewallIsolated,
      ...status,
      suggestedGuacdHost: guacdHostFromSettings(guacSettings?.url),
    };
  });

  app.post("/vms/:id/firewall", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("vm.edit")(request);
    const { allowed } = await ctx.vms.visibleTo(user.id, user.roles, id);
    if (!allowed) throw AppError.forbidden("No access to this VM");
    const vm = await ctx.vms.requireById(id);
    const body = z
      .object({
        isolated: z.boolean(),
        allowFrom: z.string().max(128).optional(),
        allowDnsTo: z.string().max(128).optional(),
        inboundPorts: z.array(z.string().min(1).max(32)).max(20).optional(),
      })
      .parse(request.body);
    const proxmox = await ctx.getProxmoxClient();
    let result: { rulesCreated: number } | { rulesRemoved: number };
    if (body.isolated) {
      result = await applyIsolation(ctx.db, proxmox, vm.id, vm.node, vm.vmid, {
        allowFrom: body.allowFrom?.trim() || undefined,
        allowDnsTo: body.allowDnsTo?.trim() || undefined,
        inboundPorts: body.inboundPorts,
      });
    } else {
      result = await removeIsolation(ctx.db, proxmox, vm.id, vm.node, vm.vmid);
    }
    await ctx.audit.record({
      event: "VM_FIREWALL_CHANGED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { isolated: body.isolated, ...result },
    });
    const status = await getIsolationStatus(proxmox, vm.node, vm.vmid);
    return { isolated: body.isolated, ...result, status };
  });

  app.post("/vms/:id/firewall/rules", async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.requirePermission("vm.edit")(request);
    const { allowed } = await ctx.vms.visibleTo(user.id, user.roles, id);
    if (!allowed) throw AppError.forbidden("No access to this VM");
    const vm = await ctx.vms.requireById(id);
    const body = assertFirewallRuleInput(request.body);
    const proxmox = await ctx.getProxmoxClient();
    await proxmox.createGuestFirewallRule(vm.node, vm.vmid, { ...body, comment: body.comment });
    await ctx.audit.record({
      event: "VM_FIREWALL_CHANGED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { ruleAdded: body },
    });
    return { ok: true };
  });

  app.delete("/vms/:id/firewall/rules/:pos", async (request, reply) => {
    const { id, pos } = request.params as { id: string; pos: string };
    const user = await app.requirePermission("vm.edit")(request);
    const { allowed } = await ctx.vms.visibleTo(user.id, user.roles, id);
    if (!allowed) throw AppError.forbidden("No access to this VM");
    const vm = await ctx.vms.requireById(id);
    const posNum = Number(pos);
    if (!Number.isInteger(posNum) || posNum < 0) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "Rule position must be a non-negative integer" });
    }
    const proxmox = await ctx.getProxmoxClient();
    const rules = await proxmox.guestFirewallRules(vm.node, vm.vmid);
    const target = rules.find((r) => Number((r as Record<string, unknown>).pos) === posNum);
    if (!target) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "No rule at that position" });
    }
    if (!isProxvmRule(target as Record<string, unknown>)) {
      return reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: "Only ProxVM-managed rules can be removed here — hand-made rules must be edited in Proxmox so nothing surprises you.",
      });
    }
    await proxmox.deleteGuestFirewallRule(vm.node, vm.vmid, posNum);
    await ctx.audit.record({
      event: "VM_FIREWALL_CHANGED",
      actorUserId: user.id,
      actorUsername: user.username,
      vmId: vm.id,
      detail: { ruleRemovedPos: posNum },
    });
    return { ok: true };
  });
}
