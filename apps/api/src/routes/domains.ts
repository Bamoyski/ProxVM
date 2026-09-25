import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import {
  AppError,
  assertValidHostname,
  getDomainConfig,
  normalizeHostname,
  removeDomainAlias,
  setCanonicalDomain,
} from "@proxvm/core";

const cloudflareSchema = z.object({
  apiToken: z.string().max(512).optional(),
  zoneId: z.string().min(1).max(128).optional(),
});

function qualifyName(name: string, zoneName: string): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed === "@") return zoneName;
  if (trimmed.includes(".")) return normalizeHostname(trimmed);
  return `${trimmed}.${zoneName}`;
}

export async function domainRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;
  const guard = app.requirePermission("settings.manage");

  app.get("/domains/config", { preHandler: guard }, async () => {
    const config = await getDomainConfig(ctx.settings);
    const token = await ctx.settings.get("cloudflare.api_token");
    return {
      canonical: config.canonical,
      aliases: config.aliases,
      cloudflare: { configured: !!token?.value, zoneId: config.cloudflareZoneId },
    };
  });

  app.put("/domains/config", async (request) => {
    const actor = await guard(request);
    const body = z.object({ canonical: z.string().min(1).max(253) }).parse(request.body);
    const config = await setCanonicalDomain(ctx.settings, body.canonical);
    await ctx.audit.record({
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { section: "domains", canonical: config.canonical, aliases: config.aliases },
    });
    return config;
  });

  app.delete("/domains/aliases/:host", async (request, reply) => {
    const actor = await guard(request);
    const { host } = request.params as { host: string };
    const config = await removeDomainAlias(ctx.settings, host);
    await ctx.audit.record({
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { section: "domains", removedAlias: normalizeHostname(host), aliases: config.aliases },
    });
    return config;
  });

  app.put("/domains/cloudflare", async (request) => {
    const actor = await guard(request);
    const body = cloudflareSchema.parse(request.body);
    if (body.apiToken !== undefined && body.apiToken !== "") {
      await ctx.settings.set("cloudflare.api_token", body.apiToken, { encrypted: true, category: "infrastructure" });
    }
    if (body.zoneId !== undefined) {
      await ctx.settings.set("cloudflare.zone_id", body.zoneId.trim(), { category: "infrastructure" });
    }
    ctx.invalidateCache();
    await ctx.audit.record({
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { section: "domains", cloudflareUpdated: true },
    });
    return { ok: true };
  });

  app.post("/domains/cloudflare/test", async (request) => {
    await guard(request);
    const client = await ctx.getCloudflareClient();
    const zoneId = (await ctx.settings.get("cloudflare.zone_id"))?.value;
    if (!zoneId) throw AppError.validation("Save a Cloudflare Zone ID first");
    const [token, zone] = await Promise.all([client.verifyToken(), client.getZone(zoneId)]);
    return { ok: true, tokenStatus: token.status, zone: { id: zone.id, name: zone.name, status: zone.status } };
  });

  app.get("/domains/dns", { preHandler: guard }, async (request) => {
    const query = z.object({ search: z.string().max(128).optional() }).parse(request.query);
    const zoneId = (await ctx.settings.get("cloudflare.zone_id"))?.value;
    if (!zoneId) throw AppError.validation("Save a Cloudflare Zone ID first");
    const client = await ctx.getCloudflareClient();
    const q = (query.search ?? "").toLowerCase();
    const records = (await client.listDnsRecords(zoneId))
      .filter((r) => ["A", "AAAA", "CNAME"].includes(r.type))
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied, ttl: r.ttl }));
    return { records };
  });

  // The money endpoint: point `name` at the same target the current canonical
  // record uses (or an explicit target), then flip canonical. The old DNS
  // record is deliberately KEPT so the old domain keeps resolving and the
  // redirect middleware can send visitors to the new one.
  app.post("/domains/switch", async (request) => {
    const actor = await guard(request);
    const body = z
      .object({
        name: z.string().min(1).max(253),
        target: z.string().max(253).optional(),
        recordType: z.enum(["A", "AAAA", "CNAME"]).optional(),
        copyFrom: z.string().max(128).optional(),
        proxied: z.boolean().optional(),
      })
      .parse(request.body);
    const zoneId = (await ctx.settings.get("cloudflare.zone_id"))?.value;
    if (!zoneId) throw AppError.validation("Save a Cloudflare Zone ID first");
    const client = await ctx.getCloudflareClient();
    const zone = await client.getZone(zoneId);
    const fqdn = qualifyName(body.name, zone.name);
    assertValidHostname(fqdn);

    const records = await client.listDnsRecords(zoneId);
    const config = await getDomainConfig(ctx.settings);
    const current = config.canonical
      ? records.find((r) => r.name.toLowerCase() === config.canonical)
      : undefined;
    // Clone-from: copy type/target/proxied from a chosen existing record.
    // Explicit fields always win over the clone source.
    const template = body.copyFrom ? records.find((r) => r.id === body.copyFrom) : undefined;
    if (body.copyFrom && !template) throw AppError.validation("Selected source record no longer exists");
    const target = body.target?.trim() || template?.content || current?.content;
    if (!target) {
      throw AppError.validation(
        "No target given and no current domain set yet — pick 'copy from existing record' or enter the target explicitly",
      );
    }
    if (/^https?:\/\//i.test(target)) {
      throw AppError.validation("Target must be a bare IP address or hostname, not a URL (no http://, no port, no path)");
    }
    const type = body.recordType ?? template?.type ?? current?.type ?? "A";
    if (type === "A" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) {
      throw AppError.validation("A records need a bare IPv4 address (e.g. 203.0.113.10)");
    }
    if (
      type === "A" &&
      (/^(10|127)\./.test(target) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(target) || /^192\.168\./.test(target) || /^169\.254\./.test(target) || /^0\./.test(target))
    ) {
      throw AppError.validation(
        "That is a private LAN address — it is unreachable on the public internet, so publishing it would break the domain. " +
          "Use your public IP (or tunnel hostname via CNAME), copied from an existing record below.",
      );
    }
    if (type === "AAAA" && !/^[0-9a-fA-F:]+$/.test(target)) {
      throw AppError.validation("AAAA records need a bare IPv6 address");
    }
    if (type === "CNAME" && !/^[A-Za-z0-9.-]+$/.test(target)) {
      throw AppError.validation("CNAME records need a bare hostname");
    }
    const existing = records.find((r) => r.name.toLowerCase() === fqdn && ["A", "AAAA", "CNAME"].includes(r.type));
    const record = existing
      ? await client.updateDnsRecord(zoneId, existing.id, {
          content: target,
          proxied: body.proxied ?? existing.proxied,
        })
      : await client.createDnsRecord(zoneId, {
          type,
          name: fqdn,
          content: target,
          proxied: body.proxied ?? template?.proxied ?? true,
        });
    const updated = await setCanonicalDomain(ctx.settings, fqdn);
    await ctx.audit.record({
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: {
        section: "domains",
        switchedTo: fqdn,
        dnsRecord: { id: record.id, type: record.type, content: record.content, proxied: record.proxied },
        aliases: updated.aliases,
      },
    });
    return { record: { id: record.id, type: record.type, name: record.name, content: record.content, proxied: record.proxied }, ...updated };
  });
}
