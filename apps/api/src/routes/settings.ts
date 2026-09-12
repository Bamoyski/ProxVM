import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import { AppError, parseDbHost, normalizeHttpBaseUrl } from "@proxvm/core";

const proxmoxSchema = z.object({
  url: z.string().url(),
  tokenId: z.string().min(1).max(256),
  tokenSecret: z.string().max(512).optional(),
  verifySsl: z.boolean().default(true),
  defaultNode: z.string().max(128).optional(),
  defaultStorage: z.string().max(128).optional(),
  defaultNetwork: z.string().max(128).optional(),
});

const guacSchema = z.object({
  dbEngine: z.enum(["postgresql", "mariadb", "mysql"]).default("postgresql"),
  url: z.string().url(),
  publicUrl: z.string().url().optional().default(""),
  dbHost: z.string().min(1).max(256),
  dbPort: z.number().int().min(1).max(65535).default(5432),
  dbName: z.string().min(1).max(128),
  dbUser: z.string().min(1).max(128),
  dbPassword: z.string().max(512).optional(),
  dbSsl: z.boolean().default(false),
});

export async function settingsRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;
  const guard = app.requirePermission("settings.manage");

  app.get("/settings/proxmox", { preHandler: guard }, async () => {
    const s = await ctx.settings.proxmox();
    if (!s) return { configured: false, settings: null };
    return {
      configured: true,
      settings: {
        url: s.url,
        tokenId: s.tokenId,
        tokenSecret: s.tokenSecret ? "********" : "",
        verifySsl: s.verifySsl,
        defaultNode: s.defaultNode,
        defaultStorage: s.defaultStorage,
        defaultNetwork: s.defaultNetwork,
      },
    };
  });

  app.put("/settings/proxmox", { preHandler: guard }, async (request) => {
    const actor = await guard(request);
    const body = proxmoxSchema.parse(request.body);
    const existing = await ctx.settings.proxmox();
    const tokenSecret = body.tokenSecret && body.tokenSecret !== "********"
      ? body.tokenSecret
      : existing?.tokenSecret;
    if (!tokenSecret) throw AppError.validation("tokenSecret is required (none stored yet)");
    await ctx.settings.set("proxmox.url", body.url, { category: "infrastructure" });
    await ctx.settings.set("proxmox.token_id", body.tokenId, { category: "infrastructure" });
    await ctx.settings.set("proxmox.token_secret", tokenSecret, { encrypted: true, category: "infrastructure" });
    await ctx.settings.set("proxmox.verify_ssl", String(body.verifySsl), { category: "infrastructure" });
    if (body.defaultNode !== undefined) await ctx.settings.set("proxmox.default_node", body.defaultNode, { category: "infrastructure" });
    if (body.defaultStorage !== undefined) await ctx.settings.set("proxmox.default_storage", body.defaultStorage, { category: "infrastructure" });
    if (body.defaultNetwork !== undefined) await ctx.settings.set("proxmox.default_network", body.defaultNetwork, { category: "infrastructure" });
    ctx.invalidateCache();
    await ctx.audit.record({
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { section: "proxmox", url: body.url },
    });
    return { ok: true };
  });

  app.get("/settings/guacamole", { preHandler: guard }, async () => {
    const g = await ctx.settings.guacamole();
    if (!g) return { configured: false, settings: null };
    return {
      configured: true,
      settings: {
        engine: g.engine,
        url: g.url,
        publicUrl: g.publicUrl ?? "",
        dbHost: g.dbHost,
        dbPort: g.dbPort,
        dbName: g.dbName,
        dbUser: g.dbUser,
        dbPassword: g.dbPassword ? "********" : "",
        dbSsl: g.dbSsl,
      },
    };
  });

  app.put("/settings/guacamole", { preHandler: guard }, async (request) => {
    const actor = await guard(request);
    const body = guacSchema.parse(request.body);
    const existing = await ctx.settings.guacamole();
    const dbPassword = body.dbPassword && body.dbPassword !== "********"
      ? body.dbPassword
      : existing?.dbPassword;
    if (!dbPassword) throw AppError.validation("dbPassword is required (none stored yet)");
    await ctx.settings.set("guacamole.db_engine", body.dbEngine, { category: "infrastructure" });
    await ctx.settings.set("guacamole.url", normalizeHttpBaseUrl(body.url), { category: "infrastructure" });
    if (body.publicUrl) {
      await ctx.settings.set("guacamole.public_url", normalizeHttpBaseUrl(body.publicUrl), { category: "infrastructure" });
    } else {
      await ctx.settings.set("guacamole.public_url", "", { category: "infrastructure" });
    }
    await ctx.settings.set("guacamole.db_host", parseDbHost(body.dbHost).host, { category: "infrastructure" });
    const guacDbParsed = parseDbHost(body.dbHost);
    await ctx.settings.set("guacamole.db_port", String(guacDbParsed.port ?? body.dbPort), { category: "infrastructure" });
    await ctx.settings.set("guacamole.db_name", body.dbName, { category: "infrastructure" });
    await ctx.settings.set("guacamole.db_user", body.dbUser, { category: "infrastructure" });
    await ctx.settings.set("guacamole.db_password", dbPassword, { encrypted: true, category: "infrastructure" });
    await ctx.settings.set("guacamole.db_ssl", String(body.dbSsl), { category: "infrastructure" });
    ctx.invalidateCache();
    await ctx.audit.record({
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { section: "guacamole", url: body.url },
    });
    return { ok: true };
  });

  app.get("/settings/app", { preHandler: guard }, async () => {
    return {
      app: {
        cookieSecure: ctx.localConfig.app.cookieSecure,
        sessionDurationHours: ctx.localConfig.app.sessionDurationHours,
        sessionIdleTimeoutMinutes: ctx.localConfig.app.sessionIdleTimeoutMinutes,
      },
    };
  });
}
