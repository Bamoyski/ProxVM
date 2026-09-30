import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import {
  AppError,
  addDomainAlias,
  assertValidHostname,
  ensureTunnelIngressRule,
  getCloudflareConfig,
  getDomainConfig,
  normalizeHostname,
  removeDomainAlias,
  setCanonicalDomain,
  tunnelServiceFor,
} from "@proxvm/core";

const cloudflareSchema = z.object({
  apiToken: z.string().max(512).optional(),
  zoneId: z.string().min(1).max(128).optional(),
  accountId: z.string().min(1).max(128).optional(),
  tunnelId: z.string().min(1).max(128).optional(),
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

  // Public on purpose (no session, no CSRF): the SPA calls this before login
  // to bounce alias hosts to the canonical domain. It reveals only hostnames
  // that are already public via DNS — never tokens, settings, or records.
  app.get("/domains/public", async () => {
    const config = await getDomainConfig(ctx.settings);
    return { canonical: config.canonical, aliases: config.aliases };
  });

  app.get("/domains/config", { preHandler: guard }, async () => {
    const [config, cf] = await Promise.all([getDomainConfig(ctx.settings), getCloudflareConfig(ctx.settings)]);
    return {
      canonical: config.canonical,
      aliases: config.aliases,
      cloudflare: {
        configured: !!cf.apiToken,
        zoneId: cf.zoneId,
        accountId: cf.accountId,
        tunnelId: cf.tunnelId,
      },
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

  app.post("/domains/aliases", async (request) => {
    const actor = await guard(request);
    const body = z.object({ host: z.string().min(1).max(253) }).parse(request.body);
    const config = await addDomainAlias(ctx.settings, body.host);
    await ctx.audit.record({
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { section: "domains", addedAlias: normalizeHostname(body.host), aliases: config.aliases },
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
    if (body.accountId !== undefined) {
      await ctx.settings.set("cloudflare.account_id", body.accountId.trim(), { category: "infrastructure" });
    }
    if (body.tunnelId !== undefined) {
      await ctx.settings.set("cloudflare.tunnel_id", body.tunnelId.trim(), { category: "infrastructure" });
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
    const cf = await getCloudflareConfig(ctx.settings);
    if (!cf.zoneId) throw AppError.validation("No Cloudflare Zone ID configured (env or Domains settings)");
    // NOTE: never gate on verifyToken() here — Cloudflare's /user/tokens/verify
    // rejects some perfectly valid restricted tokens (observed: scoped calls
    // 200 while verify 401s "Invalid API Token"). A successful zone fetch is
    // the real auth proof; tunnel listing is best-effort on top.
    const zone = await client.getZone(cf.zoneId);
    let tunnels: number | null = null;
    if (cf.accountId) {
      try {
        tunnels = (await client.listTunnels(cf.accountId)).length;
      } catch {
        tunnels = null;
      }
    }
    return { ok: true, zone: { id: zone.id, name: zone.name, status: zone.status }, tunnels };
  });

  app.get("/domains/tunnels", { preHandler: guard }, async () => {
    const accountId = (await getCloudflareConfig(ctx.settings)).accountId;
    if (!accountId) throw AppError.validation("No Cloudflare Account ID configured (env or Domains settings)");
    const client = await ctx.getCloudflareClient();
    const tunnels = await client.listTunnels(accountId);
    return { tunnels: tunnels.map((t) => ({ id: t.id, name: t.name, status: t.status ?? null })) };
  });

  // Reports whether the tunnel is cloud-managed (ProxVM can edit ingress)
  // or local-config (owner converts it once in the dashboard). Never writes.
  app.post("/domains/tunnels/test", async (request) => {
    await guard(request);
    const cf = await getCloudflareConfig(ctx.settings);
    if (!cf.accountId || !cf.tunnelId) {
      throw AppError.validation("No Cloudflare Account ID and Tunnel ID configured (env or Domains settings)");
    }
    const client = await ctx.getCloudflareClient();
    try {
      const { ingress } = await client.getTunnelIngress(cf.accountId, cf.tunnelId);
      const config = await getDomainConfig(ctx.settings);
      return {
        ok: true,
        managed: true,
        hostnames: ingress.map((r) => r.hostname).filter((h): h is string => !!h),
        routes: ingress
          .filter((r) => !!r.hostname)
          .map((r) => ({ hostname: r.hostname as string, service: r.service })),
        canonicalService: config.canonical ? tunnelServiceFor(ingress, config.canonical) : null,
      };
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        return { ok: true, managed: false, hostnames: [], routes: [], canonicalService: null };
      }
      throw err;
    }
  });

  app.get("/domains/dns", { preHandler: guard }, async (request) => {
    const query = z.object({ search: z.string().max(128).optional() }).parse(request.query);
    const zoneId = (await getCloudflareConfig(ctx.settings)).zoneId;
    if (!zoneId) throw AppError.validation("No Cloudflare Zone ID configured (env or Domains settings)");
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
        service: z.string().min(1).max(253).optional(),
      })
      .parse(request.body);
    const cfZoneId = (await getCloudflareConfig(ctx.settings)).zoneId;
    if (!cfZoneId) throw AppError.validation("No Cloudflare Zone ID configured (env or Domains settings)");
    const client = await ctx.getCloudflareClient();
    const zone = await client.getZone(cfZoneId);
    const zoneId = zone.id;
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
    // Full-auto tunnel leg: route the new hostname through the same tunnel
    // service as the current domain before anything flips, so there is never
    // a manual ingress step. Skipped silently when no tunnel is configured
    // (the old manual-ingress flow still applies then).
    let tunnel: { managed: boolean; ruleEnsured: boolean; service: string | null } = {
      managed: false,
      ruleEnsured: false,
      service: null,
    };
    const cfTunnel = await getCloudflareConfig(ctx.settings);
    const cfAccountId = cfTunnel.accountId;
    const cfTunnelId = cfTunnel.tunnelId;
    if (cfAccountId && cfTunnelId) {
      const { ingress, raw } = await client.getTunnelIngress(cfAccountId, cfTunnelId).catch((err) => {
        if (err instanceof AppError && err.statusCode === 404) {
          throw AppError.validation(
            "This tunnel runs on a local config.yml, so ProxVM cannot manage its ingress. " +
              "Convert it to a cloud-managed tunnel once in the Cloudflare dashboard (or add the hostname there by hand), then Switch again.",
          );
        }
        throw err;
      });
      const explicitService = body.service?.trim() || null;
      if (
        explicitService &&
        !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(explicitService) &&
        !/^http_status:\d{3}$/i.test(explicitService) &&
        explicitService !== "hello-world"
      ) {
        throw AppError.validation(
          `Service target "${explicitService}" is not a valid tunnel service — use scheme://host form (e.g. http://localhost:8080), http_status:404, or hello-world. Pick one from the existing routes below instead of typing.`,
        );
      }
      const service =
        explicitService ||
        (config.canonical ? tunnelServiceFor(ingress, config.canonical) : null);
      if (!service) {
        throw AppError.validation(
          "No ingress rule exists for the current domain and no service target was given — pick the service from an existing route below (same target your current domain uses).",
        );
      }
      const merged = ensureTunnelIngressRule(ingress, fqdn, service);
      if (merged.changed) {
        await client.putTunnelIngress(cfAccountId, cfTunnelId, raw, merged.rules);
      }
      tunnel = { managed: true, ruleEnsured: true, service };
    }
    // Verify before flipping: pointing canonical at an unresolvable name
    // would bounce every old URL into the void. DNS is the hard gate; the
    // HTTPS probe is advisory (grey-cloud records and still-provisioning
    // certificates are the proxy's job, not a veto).
    const verification = await ctx.verifyDomain(fqdn);
    if (!verification.dnsOk) {
      await ctx.audit.record({
        event: "SETTINGS_CHANGED",
        actorUserId: actor.id,
        actorUsername: actor.username,
        detail: { section: "domains", switchAborted: fqdn, reason: verification.detail },
      });
      throw AppError.validation(
        `DNS for ${fqdn} does not resolve yet (${verification.detail}). The DNS record was saved — wait for propagation (or fix the target) and Switch again. Nothing was flipped.`,
      );
    }
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
        tunnel,
        verification,
      },
    });
    return {
      record: { id: record.id, type: record.type, name: record.name, content: record.content, proxied: record.proxied },
      tunnel,
      verification,
      ...updated,
    };
  });
}
