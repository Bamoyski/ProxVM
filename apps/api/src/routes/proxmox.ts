import type { FastifyInstance } from "fastify";
import type { CoreContext } from "@proxvm/core";
import { AppError } from "@proxvm/core";

// Proxmox node names are interpolated into upstream API paths: restrict the
// shape so `?node=` cannot escape into unintended paths or query strings.
const NODE_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function requireNode(query: unknown): string {
  const node = (query as { node?: string } | null)?.node;
  if (!node || typeof node !== "string") {
    throw AppError.validation("node query parameter is required");
  }
  if (!NODE_PATTERN.test(node)) {
    throw AppError.validation("Invalid node name");
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
    const rows = await client.storages(node);
    // Project: upstream storage rows can carry config text, digests and
    // comments — tenants only need capacity/identity fields.
    return {
      storage: rows.map((s) => ({
        node: s.node ?? node,
        storage: s.storage ?? null,
        type: s.type ?? null,
        content: s.content ?? null,
        total: s.total ?? null,
        used: s.used ?? null,
        avail: s.avail ?? null,
        shared: s.shared ?? null,
        active: s.active ?? null,
        enabled: s.enabled ?? null,
      })),
    };
  });

  app.get("/proxmox/networks", async (request) => {
    await guard(request);
    const client = await opts.ctx.getProxmoxClient();
    const node = requireNode(request.query);
    const rows = await client.networks(node);
    return {
      networks: rows.map((n) => ({
        iface: n.iface ?? null,
        type: n.type ?? null,
        address: n.address ?? null,
        netmask: n.netmask ?? null,
        gateway: n.gateway ?? null,
        bridge_ports: n.bridge_ports ?? null,
        active: n.active ?? null,
      })),
    };
  });

  app.get("/proxmox/templates", async (request) => {
    await guard(request);
    const client = await opts.ctx.getProxmoxClient();
    return { templates: await client.templates() };
  });
}