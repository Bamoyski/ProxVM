import type { FastifyInstance } from "fastify";
import type { CoreContext } from "@proxvm/core";
import { AppError } from "@proxvm/core";

function requireNode(query: unknown): string {
  const node = (query as { node?: string } | null)?.node;
  if (!node || typeof node !== "string") {
    throw AppError.validation("node query parameter is required");
  }
  return node;
}

export async function proxmoxRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const guard = app.requirePermission("proxmox.read");

  app.get("/proxmox/status", async (request) => {
    await guard(request);
    try {
      const client = await opts.ctx.getProxmoxClient();
      const version = await client.version();
      const nodes = await client.nodes();
      return {
        connected: true,
        version: version.version,
        release: version.release,
        nodes: nodes.map((n) => ({
          node: n.node,
          status: n.status,
          cpu: n.cpu,
          maxcpu: n.maxcpu,
          mem: n.mem,
          maxmem: n.maxmem,
          uptime: n.uptime,
          pveversion: n.pveversion,
        })),
      };
    } catch (err) {
      return {
        connected: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.get("/proxmox/nodes", async (request) => {
    await guard(request);
    const client = await opts.ctx.getProxmoxClient();
    return { nodes: await client.nodeStatus() };
  });

  app.get("/proxmox/storage", async (request) => {
    await guard(request);
    const client = await opts.ctx.getProxmoxClient();
    const node = requireNode(request.query);
    return { storage: await client.storages(node) };
  });

  app.get("/proxmox/networks", async (request) => {
    await guard(request);
    const client = await opts.ctx.getProxmoxClient();
    const node = requireNode(request.query);
    return { networks: await client.networks(node) };
  });

  app.get("/proxmox/templates", async (request) => {
    await guard(request);
    const client = await opts.ctx.getProxmoxClient();
    return { templates: await client.templates() };
  });
}