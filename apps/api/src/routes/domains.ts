// ---------------------------------------------------------------------------
// Domains routes: canonical/alias config, Cloudflare DNS + tunnel mgmt,
//   domain switch (DNS + tunnel + verify + flip), Securly filter watch.
// Permissions: /domains/public is intentionally unauthenticated (pre-login
//   alias bounce; hostnames only, already public via DNS); everything else
//   requires settings.manage.
// Rate limits: none (admin-only writes; each mutation is audited).
// Security: tokens never returned (configured boolean only); targets reject
//   URLs/private IPs; tunnel writes are blocked for local-config tunnels;
//   switch verifies DNS before flipping canonical so URLs never void.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import {
  AppError,
  AUTO_ROTATE_ENABLED_KEY,
  addDomainAlias,
  checkSecurlyBlock,
  getCloudflareConfig,
  getDomainConfig,
  getSecurlyConfig,
  normalizeHostname,
  performDomainSwitch,
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

/**
 * Register domain/Cloudflare/tunnel/filter-check endpoints.
 * WHY public + private split: the SPA must resolve the canonical host before
 * login, so only that hostname-only read is public; all control stays gated.
 */
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
    const [config, cf, rotate] = await Promise.all([
      getDomainConfig(ctx.settings),
      getCloudflareConfig(ctx.settings),
      ctx.settings.get(AUTO_ROTATE_ENABLED_KEY),
    ]);
    return {
      canonical: config.canonical,
      aliases: config.aliases,
      autoRotate: rotate?.value === "true",
      cloudflare: {
        configured: !!cf.apiToken,
        zoneId: cf.zoneId,
        accountId: cf.accountId,
        tunnelId: cf.tunnelId,
      },
    };
  });

  // Auto-rotate on school block: when the Securly watch reads DENY for the
  // current canonical (poll every 5 min while enabled), the next numbered
  // hostname gets the full switch flow — DNS copy, tunnel route, verify,
  // flip — automatically, capped and audit/alerted like everything else.
  app.put("/domains/auto-rotate", async (request) => {
    const actor = await guard(request);
    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    await ctx.settings.set(AUTO_ROTATE_ENABLED_KEY, body.enabled ? "true" : "false", { category: "system" });
    await app.audit(request, {
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { section: "domains", autoRotate: body.enabled },
    });
    return { ok: true, enabled: body.enabled };
  });

  app.put("/domains/config", async (request) => {
    const actor = await guard(request);
    const body = z.object({ canonical: z.string().min(1).max(253) }).parse(request.body);
    const config = await setCanonicalDomain(ctx.settings, body.canonical);
    await app.audit(request, {
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
    await app.audit(request, {
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
    await app.audit(request, {
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
    await app.audit(request, {
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

  // School-filter watch: asks Securly's broker whether the CURRENT canonical
  // domain is blocked for the configured school user. Admin-only alert feed —
  // never blocks, never rotates, never audits (it's a read-only poll).
  app.get("/domains/filter-check", { preHandler: guard }, async () => {
    const config = await getDomainConfig(ctx.settings);
    if (!config.canonical) {
      return { status: "unconfigured", hostname: null, verdict: null, ruleId: null, detail: "No canonical domain set" };
    }
    const { useremail } = await getSecurlyConfig(ctx.settings);
    if (!useremail) {
      return {
        status: "unconfigured",
        hostname: config.canonical,
        verdict: null,
        ruleId: null,
        detail: "No school user email configured (PROXVM_SECURILY_USEREMAIL or Domains settings)",
      };
    }
    return checkSecurlyBlock(config.canonical, useremail);
  });

  app.put("/domains/securly", async (request) => {
    const actor = await guard(request);
    const body = z.object({ useremail: z.string().max(254) }).parse(request.body);
    const clean = body.useremail.trim();
    if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      throw AppError.validation("That does not look like an email address");
    }
    if (clean) {
      await ctx.settings.set("securly.useremail", clean, { category: "system" });
    } else {
      await ctx.db.query("DELETE FROM settings WHERE key = 'securly.useremail'");
    }
    await app.audit(request, {
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { section: "securly", configured: !!clean },
    });
    return { ok: true, configured: !!clean };
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
  // The full mechanics (record create/update, tunnel ingress ensure, DNS
  // verify gate, canonical flip + alias) live in performDomainSwitch so the
  // Securly auto-rotator runs the exact same flow.
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
    const outcome = await performDomainSwitch(
      { settings: ctx.settings, getCloudflareClient: ctx.getCloudflareClient, verifyDomain: ctx.verifyDomain },
      body,
    );
    if (!outcome.flipped) {
      await app.audit(request, {
        event: "SETTINGS_CHANGED",
        actorUserId: actor.id,
        actorUsername: actor.username,
        detail: { section: "domains", switchAborted: outcome.fqdn, reason: outcome.verification?.detail ?? outcome.abortReason },
      });
      throw AppError.validation(outcome.abortReason ?? "Switch aborted before flipping");
    }
    await app.audit(request, {
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: {
        section: "domains",
        switchedTo: outcome.fqdn,
        dnsRecord: outcome.record,
        aliases: outcome.aliases,
        tunnel: outcome.tunnel,
        verification: outcome.verification,
      },
    });
    return {
      record: outcome.record,
      tunnel: outcome.tunnel,
      verification: outcome.verification,
      canonical: outcome.canonical,
      aliases: outcome.aliases,
    };
  });
}
