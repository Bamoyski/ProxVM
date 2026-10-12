// ---------------------------------------------------------------------------
// Settings routes: app/proxmox/guacamole get + put (admin console backing).
// Permissions: every endpoint requires settings.manage (ADMIN-only in the
//   default role matrix); no self-service or per-VM paths live here.
// Rate limits: none (admin-only surface; changes are infrequent + audited).
// Security: secrets round-trip masked ("********" keeps the stored value);
//   URLs pass SSRF guards; webhook/CIDR inputs are allowlist-validated;
//   client caches are invalidated on every write; changes are audited.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import { AppError, assertSafeServerUrl, assertSafeWebhookUrl, getAnnouncement, parseCidrList, parseDbHost, normalizeHttpBaseUrl, setAnnouncement } from "@proxvm/core";

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

/**
 * Register admin settings read/write endpoints.
 * WHY masked-secret round-tripping: the UI cannot hold plaintext secrets, so
 * the sentinel preserves stored values while still allowing explicit rotate.
 */
export async function settingsRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;
  const guard = app.requirePermission("settings.manage");

  // -- App-wide tunables (retention, announcements, ceilings) ----------------
  app.put("/settings/app", async (request) => {
    const actor = await guard(request);
    const body = z
      .object({
        retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
        announcementText: z.string().max(500).nullable().optional(),
        announcementLevel: z.enum(["info", "warn"]).optional(),
        idleShutdownEnabled: z.boolean().optional(),
        idleMinutes: z.number().int().min(5).max(10080).optional(),
        threatWebhookUrl: z.string().max(512).nullable().optional(),
        threatMinSeverity: z.enum(["critical", "high", "medium", "low"]).optional(),
        maxCpu: z.number().int().min(1).max(4096).nullable().optional(),
        maxRamMb: z.number().int().min(256).max(8388608).nullable().optional(),
        maxDiskGb: z.number().min(1).max(131072).nullable().optional(),
        staticAllowedCidrs: z.string().max(1024).nullable().optional(),
      })
      .parse(request.body);
    if (body.retentionDays !== undefined) {
      if (body.retentionDays === null) {
        await ctx.db.query("DELETE FROM settings WHERE key = 'audit.retention_days'");
      } else {
        await ctx.settings.set("audit.retention_days", String(body.retentionDays), { category: "system" });
      }
    }
    if (body.announcementText !== undefined || body.announcementLevel !== undefined) {
      const current = await getAnnouncement(ctx.settings);
      const text = body.announcementText === undefined ? (current?.text ?? null) : body.announcementText;
      await setAnnouncement(ctx.settings, text, body.announcementLevel ?? current?.level ?? "info");
    }
    if (body.idleShutdownEnabled !== undefined) {
      await ctx.settings.set("power.idle_shutdown_enabled", body.idleShutdownEnabled ? "true" : "false", {
        category: "system",
      });
    }
    if (body.idleMinutes !== undefined) {
      await ctx.settings.set("power.idle_minutes", String(body.idleMinutes), { category: "system" });
    }
    if (body.threatWebhookUrl !== undefined) {
      if (body.threatWebhookUrl === null || body.threatWebhookUrl.trim() === "") {
        await ctx.db.query("DELETE FROM settings WHERE key = 'threats.webhook_url'");
      } else {
        assertSafeWebhookUrl(body.threatWebhookUrl);
        await ctx.settings.set("threats.webhook_url", body.threatWebhookUrl.trim(), { category: "system" });
      }
    }
    if (body.threatMinSeverity !== undefined) {
      await ctx.settings.set("threats.min_severity", body.threatMinSeverity, { category: "system" });
    }
    if (body.maxCpu !== undefined) {
      if (body.maxCpu === null) await ctx.db.query("DELETE FROM settings WHERE key = 'provision.max_cpu'");
      else await ctx.settings.set("provision.max_cpu", String(body.maxCpu), { category: "system" });
    }
    if (body.maxRamMb !== undefined) {
      if (body.maxRamMb === null) await ctx.db.query("DELETE FROM settings WHERE key = 'provision.max_ram_mb'");
      else await ctx.settings.set("provision.max_ram_mb", String(body.maxRamMb), { category: "system" });
    }
    if (body.maxDiskGb !== undefined) {
      if (body.maxDiskGb === null) await ctx.db.query("DELETE FROM settings WHERE key = 'provision.max_disk_gb'");
      else await ctx.settings.set("provision.max_disk_gb", String(body.maxDiskGb), { category: "system" });
    }
    if (body.staticAllowedCidrs !== undefined) {
      if (body.staticAllowedCidrs === null || body.staticAllowedCidrs.trim() === "") {
        await ctx.db.query("DELETE FROM settings WHERE key = 'network.static_allowed_cidrs'");
      } else {
        parseCidrList(body.staticAllowedCidrs);
        await ctx.settings.set("network.static_allowed_cidrs", body.staticAllowedCidrs.trim(), { category: "system" });
      }
    }
    await app.audit(request, {
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: {
        section: "app",
        retentionDays: body.retentionDays,
        announcementChanged: body.announcementText !== undefined,
        idleShutdownEnabled: body.idleShutdownEnabled,
        idleMinutes: body.idleMinutes,
        threatWebhookChanged: body.threatWebhookUrl !== undefined,
        threatMinSeverity: body.threatMinSeverity,
        maxCpu: body.maxCpu,
        maxRamMb: body.maxRamMb,
        maxDiskGb: body.maxDiskGb,
        staticAllowedCidrsChanged: body.staticAllowedCidrs !== undefined,
      },
    });
    return { ok: true };
  });

  // -- Proxmox connection (masked secret round-trip) -------------------------
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
    await assertSafeServerUrl(body.url, "Proxmox URL");
    await ctx.settings.set("proxmox.url", body.url, { category: "infrastructure" });
    await ctx.settings.set("proxmox.token_id", body.tokenId, { category: "infrastructure" });
    await ctx.settings.set("proxmox.token_secret", tokenSecret, { encrypted: true, category: "infrastructure" });
    await ctx.settings.set("proxmox.verify_ssl", String(body.verifySsl), { category: "infrastructure" });
    if (body.defaultNode !== undefined) await ctx.settings.set("proxmox.default_node", body.defaultNode, { category: "infrastructure" });
    if (body.defaultStorage !== undefined) await ctx.settings.set("proxmox.default_storage", body.defaultStorage, { category: "infrastructure" });
    if (body.defaultNetwork !== undefined) await ctx.settings.set("proxmox.default_network", body.defaultNetwork, { category: "infrastructure" });
    ctx.invalidateCache();
    await app.audit(request, {
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { section: "proxmox", url: body.url },
    });
    return { ok: true };
  });

  // -- Guacamole connection (masked secret round-trip) -----------------------
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
    const normalizedGuacUrl = normalizeHttpBaseUrl(body.url);
    await assertSafeServerUrl(normalizedGuacUrl, "Guacamole URL");
    if (body.publicUrl) {
      await assertSafeServerUrl(normalizeHttpBaseUrl(body.publicUrl), "Guacamole public URL");
    }
    await ctx.settings.set("guacamole.db_engine", body.dbEngine, { category: "infrastructure" });
    await ctx.settings.set("guacamole.url", normalizedGuacUrl, { category: "infrastructure" });
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
    await app.audit(request, {
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { section: "guacamole", url: body.url },
    });
    return { ok: true };
  });

  app.get("/settings/app", { preHandler: guard }, async () => {
    const retention = await ctx.settings.get("audit.retention_days");
    const announcement = await getAnnouncement(ctx.settings);
    const idleEnabled = await ctx.settings.get("power.idle_shutdown_enabled");
    const idleMinutes = await ctx.settings.get("power.idle_minutes");
    const threatWebhookUrl = await ctx.settings.get("threats.webhook_url");
    const threatMinSeverity = await ctx.settings.get("threats.min_severity");
    const maxCpu = await ctx.settings.get("provision.max_cpu");
    const maxRamMb = await ctx.settings.get("provision.max_ram_mb");
    const maxDiskGb = await ctx.settings.get("provision.max_disk_gb");
    const staticAllowedCidrs = await ctx.settings.get("network.static_allowed_cidrs");
    return {
      app: {
        cookieSecure: ctx.localConfig.app.cookieSecure,
        sessionDurationHours: ctx.localConfig.app.sessionDurationHours,
        sessionIdleTimeoutMinutes: ctx.localConfig.app.sessionIdleTimeoutMinutes,
      },
      settings: {
        retentionDays: retention ? Number(retention.value) : null,
        announcementText: announcement?.text ?? null,
        announcementLevel: announcement?.level ?? "info",
        idleShutdownEnabled: (idleEnabled?.value ?? "false") === "true",
        idleMinutes: idleMinutes ? Number(idleMinutes.value) : 120,
        threatWebhookUrl: threatWebhookUrl?.value ?? null,
        threatMinSeverity: threatMinSeverity?.value ?? "high",
        maxCpu: maxCpu ? Number(maxCpu.value) : null,
        maxRamMb: maxRamMb ? Number(maxRamMb.value) : null,
        maxDiskGb: maxDiskGb ? Number(maxDiskGb.value) : null,
        staticAllowedCidrs: staticAllowedCidrs?.value ?? null,
      },
    };
  });
}
