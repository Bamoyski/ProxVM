// ---------------------------------------------------------------------------
// Domain auto-rotation:
// - performDomainSwitch: the complete canonical-switch flow (target resolution
//   + validation, DNS record create/update, tunnel ingress ensure, DNS verify
//   gate, canonical flip, old host kept as alias) extracted from the admin
//   route so manual switches and the automatic Securly rotator share one
//   code path.
// - runFilterRotatePass: the periodic gate chain. ONLY an explicit Securly
//   DENY verdict on the current canonical triggers a rotation (unknown and
//   timeouts never do); every candidate name is pre-checked against the
//   broker so a rotation never lands on another blocked hostname. Every
//   meaningful outcome audits and alerts admins; cooldown gates re-attempts,
//   a daily cap stops runaway rotation loops.
// - Name generation bumps the trailing digit of the first label (proxvm6 →
//   proxvm7, proxvm9 → proxvm10); labels without a digit get "2" appended
//   (app.example.com → app2.example.com). Names already used as canonical or
//   alias, or rejected as blocked, are skipped upward.
// ---------------------------------------------------------------------------
import type IORedis from "ioredis";
import type { AuditService } from "./audit.js";
import type { Queryable } from "../db/pool.js";
import type { Logger } from "../util/logger.js";
import type { SettingsService } from "./settings.js";
import type { FilterCheckResult } from "./filtercheck.js";
import type { DomainVerification } from "./domains.js";
import { AppError } from "../util/errors.js";
import {
  ensureTunnelIngressRule,
  tunnelServiceFor,
  type CloudflareClient,
} from "../cloudflare/client.js";
import {
  assertValidHostname,
  getCloudflareConfig,
  getDomainConfig,
  normalizeHostname,
  setCanonicalDomain,
} from "./domains.js";
import { checkSecurlyBlock, getSecurlyConfig } from "./filtercheck.js";
import { alertAdmins } from "./gotify.js";

/** Expand a bare label to a FQDN within the zone (@ means the apex). */
export function qualifyName(name: string, zoneName: string): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed === "@") return zoneName;
  if (trimmed.includes(".")) return normalizeHostname(trimmed);
  return `${trimmed}.${zoneName}`;
}

/** True for ASCII digits only (no locale games). */
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/**
 * Bump the trailing digit run of the FIRST label by one. No trailing digits
 * means append "2". "proxvm6" → "proxvm7", "proxvm9" → "proxvm10",
 * "app.example.com" → "app2.example.com". Linear scan (no regex) matching
 * the hostname-parsing discipline in domains.ts.
 */
export function bumpHostname(hostname: string): string {
  const dot = hostname.indexOf(".");
  const label = dot === -1 ? hostname : hostname.slice(0, dot);
  const rest = dot === -1 ? "" : hostname.slice(dot);
  let i = label.length;
  while (i > 0 && isDigit(label.charCodeAt(i - 1))) i--;
  if (i === label.length) return `${label}2${rest}`;
  const head = label.slice(0, i);
  // Label validation guarantees digits only in the tail, so Number is exact.
  return `${head}${Number(label.slice(i)) + 1}${rest}`;
}

/**
 * Next unused rotated name at-or-above the canonical one, or null after
 * `maxAttempts` collisions. "Used" means: current canonical, any redirect
 * alias, or any previously-probed candidate.
 */
export function nextRotatedHostname(
  canonical: string,
  used: Iterable<string>,
  maxAttempts = 16,
): string | null {
  const skipped = new Set<string>();
  for (const h of used) {
    const norm = normalizeHostname(h);
    if (norm) skipped.add(norm);
  }
  let current = normalizeHostname(canonical);
  if (!current) return null;
  for (let i = 0; i < maxAttempts; i++) {
    const next = bumpHostname(current);
    current = next;
    if (!skipped.has(next)) return next;
  }
  return null;
}

// --- Shared switch flow -----------------------------------------------------

export interface SwitchDomainDeps {
  settings: Pick<SettingsService, "get" | "set">;
  getCloudflareClient: () => Promise<CloudflareClient>;
  verifyDomain: (fqdn: string) => Promise<DomainVerification>;
}

export interface SwitchDomainInput {
  name: string;
  target?: string;
  recordType?: "A" | "AAAA" | "CNAME";
  copyFrom?: string;
  proxied?: boolean;
  service?: string;
}

export interface SwitchDomainRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

export interface SwitchDomainResult {
  /** False means the DNS verify gate aborted: record saved, NOTHING flipped. */
  flipped: boolean;
  fqdn: string;
  record: SwitchDomainRecord | null;
  tunnel: { managed: boolean; ruleEnsured: boolean; service: string | null };
  verification: DomainVerification | null;
  canonical: string | null;
  aliases: string[];
  abortReason: string | null;
}

/**
 * Create-or-update the DNS record for `name`, route it through the same
 * tunnel service as the current domain, verify DNS, then flip canonical.
 * The old canonical host is kept as a redirect alias and its DNS record is
 * NEVER deleted, so the old URLs keep resolving and redirecting.
 * Validation failures throw AppError; ONLY the DNS verify gate returns a
 * non-flipping result (the record was already written at that point).
 */
export async function performDomainSwitch(
  deps: SwitchDomainDeps,
  body: SwitchDomainInput,
): Promise<SwitchDomainResult> {
  const cfZoneId = (await getCloudflareConfig(deps.settings)).zoneId;
  if (!cfZoneId) throw AppError.validation("No Cloudflare Zone ID configured (env or Domains settings)");
  const client = await deps.getCloudflareClient();
  const zone = await client.getZone(cfZoneId);
  const zoneId = zone.id;
  const fqdn = qualifyName(body.name, zone.name);
  assertValidHostname(fqdn);

  const records = await client.listDnsRecords(zoneId);
  const config = await getDomainConfig(deps.settings);
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
  const cfTunnel = await getCloudflareConfig(deps.settings);
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
  const verification = await deps.verifyDomain(fqdn);
  if (!verification.dnsOk) {
    return {
      flipped: false,
      fqdn,
      record: { id: record.id, type: record.type, name: record.name, content: record.content, proxied: record.proxied },
      tunnel,
      verification,
      canonical: config.canonical,
      aliases: config.aliases,
      abortReason: `DNS for ${fqdn} does not resolve yet (${verification.detail}). The DNS record was saved — wait for propagation (or fix the target) and Switch again. Nothing was flipped.`,
    };
  }
  const updated = await setCanonicalDomain(deps.settings, fqdn);
  return {
    flipped: true,
    fqdn,
    record: { id: record.id, type: record.type, name: record.name, content: record.content, proxied: record.proxied },
    tunnel,
    verification,
    canonical: updated.canonical,
    aliases: updated.aliases,
    abortReason: null,
  };
}

// --- Automatic Securly rotator ----------------------------------------------

export const AUTO_ROTATE_ENABLED_KEY = "domains.auto_rotate";
export const AUTO_ROTATE_COOLDOWN_S = 15 * 60;
export const AUTO_ROTATE_MAX_PER_DAY = 5;
const AUTO_ROTATE_MAX_CANDIDATES = 10;
// Cooldowns after a non-success outcome so a persistent failure alerts once,
// not once every ticker tick.
const RETRY_COOLDOWN_S = 30 * 60;
const FAILURE_COOLDOWN_S = 60 * 60;

interface RotateDeps {
  settings: Pick<SettingsService, "get" | "set" | "getPlain">;
  redis: Pick<IORedis, "get" | "set" | "incr" | "expire" | "del">;
  getCloudflareClient: () => Promise<CloudflareClient>;
  verifyDomain: (fqdn: string) => Promise<DomainVerification>;
  audit: Pick<AuditService, "record">;
  db: Queryable;
  logger: Pick<Logger, "info" | "warn" | "debug">;
}

export type AutoRotateOutcome =
  | "disabled"
  | "no-canonical"
  | "no-useremail"
  | "cooldown"
  | "clean"
  | "unknown"
  | "rotated"
  | "no-clean-candidate"
  | "broker-down"
  | "aborted"
  | "failed"
  | "capped";

export interface AutoRotateResult {
  outcome: AutoRotateOutcome;
  from?: string;
  to?: string;
  ruleId?: string | null;
  detail?: string;
}

export interface AutoRotateOpts {
  /** Test seam: overrides the Securly broker probe for every check. */
  check?: (hostname: string, useremail: string) => Promise<FilterCheckResult>;
  cooldownS?: number;
  maxPerDay?: number;
}

const COOLDOWN_KEY = "proxvm:auto-rotate:cooldown";
const CAPPED_TTL_S = 26 * 60 * 60;
const COUNT_TTL_S = 2 * 24 * 60 * 60;

function dayKey(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

export async function runFilterRotatePass(
  deps: RotateDeps,
  opts: AutoRotateOpts = {},
): Promise<AutoRotateResult> {
  const { settings, redis, audit, db, logger } = deps;
  const cooldownKey = COOLDOWN_KEY;
  const cooldownS = opts.cooldownS ?? AUTO_ROTATE_COOLDOWN_S;
  try {
    if ((await settings.get(AUTO_ROTATE_ENABLED_KEY))?.value !== "true") {
      return { outcome: "disabled" };
    }
    const config = await getDomainConfig(settings);
    if (!config.canonical) return { outcome: "no-canonical" };
    const { useremail } = await getSecurlyConfig(settings);
    if (!useremail) return { outcome: "no-useremail" };

    if (await redis.get(cooldownKey)) return { outcome: "cooldown", from: config.canonical };

    const check = opts.check ?? ((hostname: string, email: string) => checkSecurlyBlock(hostname, email));
    const verdict = await check(config.canonical, useremail);
    if (verdict.status === "clean") return { outcome: "clean", from: config.canonical };
    if (verdict.status !== "blocked") {
      // Unknown/timeout: never rotate on an unreliable oracle, never alert
      // (the strict pass would page every broker blip); log and move on.
      logger.debug({ hostname: config.canonical, detail: verdict.detail }, "auto-rotate check inconclusive");
      return { outcome: "unknown", from: config.canonical, detail: verdict.detail };
    }

    const cap = opts.maxPerDay ?? AUTO_ROTATE_MAX_PER_DAY;
    const countKey = `proxvm:auto-rotate:count:${dayKey()}`;
    const done = Number((await redis.get(countKey)) ?? "0");
    if (done >= cap) {
      const cappedKey = `proxvm:auto-rotate:capped:${dayKey()}`;
      if (!(await redis.get(cappedKey))) {
        await alertAdmins(db, settings, logger, {
          title: `Auto-rotate paused — daily cap reached (${done}/${cap})`,
          body: `Securly still reports ${config.canonical} blocked${verdict.ruleId ? ` (rule ${verdict.ruleId})` : ""}, but ${done} automatic rotation(s) already happened today. Rotate manually on the Domains page or raise the cap once things settle.`,
          link: "/domains",
          priority: 7,
        });
        await redis.set(cappedKey, "1", "EX", CAPPED_TTL_S).catch(() => undefined);
      }
      return { outcome: "capped", from: config.canonical, ruleId: verdict.ruleId, detail: `${done}/${cap}` };
    }

    // Candidate search: bump numbers upward, skipping every name already
    // listed (canonical/alias) or rejected as blocked, until the broker
    // confirms one is clean. An UNKNOWN verdict stops the search entirely —
    // switching blind on an unreliable oracle could publish a dead domain.
    const probed = new Set<string>([config.canonical, ...config.aliases]);
    let candidate: string | null = null;
    let brokerDirty = false;
    for (let attempt = 0; attempt < AUTO_ROTATE_MAX_CANDIDATES && !candidate; attempt++) {
      const next = nextRotatedHostname(config.canonical, probed, AUTO_ROTATE_MAX_CANDIDATES);
      if (!next) break;
      probed.add(next);
      const v = await check(next, useremail);
      if (v.status === "clean") {
        candidate = next;
        break;
      }
      if (v.status === "unknown") {
        brokerDirty = true;
        break;
      }
    }
    if (!candidate) {
      const detail = brokerDirty
        ? `Securly's broker returned an unknown verdict while checking the next name after ${config.canonical}, so auto-rotate will not switch blind.`
        : `Securly also blocks the next ${AUTO_ROTATE_MAX_CANDIDATES} name(s) after ${config.canonical} — the whole numbering pattern looks listed.`;
      await safeAudit(audit, logger, {
        section: "domains",
        autoRotate: "no-clean-candidate",
        canonical: config.canonical,
        reason: detail,
      });
      await alertAdmins(db, settings, logger, {
        title: brokerDirty ? "Auto-rotate paused — Securly broker giving unclear answers" : "Auto-rotate stopped — the next names are blocked too",
        body: `${detail} Nothing was switched; the next attempt is after a cooldown.`,
        link: "/domains",
        priority: 8,
      });
      await redis.set(cooldownKey, "1", "EX", RETRY_COOLDOWN_S).catch(() => undefined);
      return { outcome: brokerDirty ? "broker-down" : "no-clean-candidate", from: config.canonical };
    }

    // Target fidelity: clone the current canonical record exactly (same
    // target, type, and proxy state) so the new domain serves the same thing.
    const cf = await getCloudflareConfig(settings);
    if (!cf.zoneId) throw AppError.validation("No Cloudflare Zone ID configured (env or Domains settings)");
    const client = await deps.getCloudflareClient();
    const zone = await client.getZone(cf.zoneId);
    const records = await client.listDnsRecords(zone.id);
    const currentRecord = records.find((r) => r.name.toLowerCase() === config.canonical);
    if (!currentRecord) {
      const detail = `No DNS record exists for ${config.canonical} in the zone, so there is no target to copy — rotating would publish a dead address.`;
      await safeAudit(audit, logger, {
        section: "domains",
        autoRotate: "failed",
        canonical: config.canonical,
        reason: detail,
      });
      await alertAdmins(db, settings, logger, {
        title: "Auto-rotate stopped — no current DNS record to copy",
        body: detail,
        link: "/domains",
        priority: 8,
      });
      await redis.set(cooldownKey, "1", "EX", FAILURE_COOLDOWN_S).catch(() => undefined);
      return { outcome: "failed", from: config.canonical, detail };
    }

    const switchResult = await performDomainSwitch(deps, {
      name: candidate,
      target: currentRecord.content,
      recordType: currentRecord.type === "A" || currentRecord.type === "AAAA" || currentRecord.type === "CNAME" ? currentRecord.type : "A",
      proxied: currentRecord.proxied,
    });
    if (!switchResult.flipped) {
      // DNS verify gate: the record was saved but nothing flipped. Rotate
      // again after the normal cooldown once the name starts resolving.
      await safeAudit(audit, logger, {
        section: "domains",
        switchAborted: switchResult.fqdn,
        autoRotate: true,
        reason: switchResult.verification?.detail,
      });
      await alertAdmins(db, settings, logger, {
        title: `Auto-rotate waiting on DNS for ${switchResult.fqdn}`,
        body: `${switchResult.abortReason} The record exists; once it resolves, auto-rotate flips automatically.`,
        link: "/domains",
        priority: 7,
      });
      await redis.set(cooldownKey, "1", "EX", cooldownS).catch(() => undefined);
      return { outcome: "aborted", from: config.canonical, detail: switchResult.verification?.detail };
    }

    // State first (cooldown + daily counter), then audit + alert, so a
    // notification hiccup can never restart the rotation loop.
    await redis.set(cooldownKey, "1", "EX", cooldownS).catch(() => undefined);
    await redis.incr(countKey).catch(() => undefined);
    await redis.expire(countKey, COUNT_TTL_S).catch(() => undefined);
    await safeAudit(audit, logger, {
      section: "domains",
      autoRotated: true,
      from: config.canonical,
      to: switchResult.canonical,
      ruleId: verdict.ruleId,
      dnsRecord: switchResult.record,
      tunnel: switchResult.tunnel,
      verification: switchResult.verification,
    });
    const rule = verdict.ruleId ? ` (rule ${verdict.ruleId})` : "";
    await alertAdmins(db, settings, logger, {
      title: `Domain auto-rotated: ${config.canonical} → ${switchResult.canonical}`,
      body:
        `Securly reports ${config.canonical} blocked${rule}. Auto-rotate created the DNS record for ${switchResult.canonical}` +
        ` (same target: ${switchResult.record?.content ?? "n/a"})${switchResult.tunnel.managed ? ", ensured the tunnel route" : ""}, and verified DNS.` +
        ` Old URLs redirect to the new domain automatically.`,
      link: "/domains",
      priority: 7,
    });
    logger.info(
      { from: config.canonical, to: switchResult.canonical, ruleId: verdict.ruleId },
      "auto domain rotation completed",
    );
    return { outcome: "rotated", from: config.canonical, to: switchResult.canonical ?? candidate, ruleId: verdict.ruleId };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ error: detail.slice(0, 200) }, "auto domain rotation failed");
    await safeAudit(audit, logger, { section: "domains", autoRotate: "failed", error: detail.slice(0, 300) });
    await alertAdmins(db, settings, logger, {
      title: "Domain auto-rotate failed",
      body: `${detail.slice(0, 300)} Nothing was switched; the next attempt is after a cooldown.`,
      link: "/domains",
      priority: 7,
    });
    await redis
      .set(COOLDOWN_KEY, "1", "EX", FAILURE_COOLDOWN_S)
      .catch(() => undefined);
    return { outcome: "failed", detail: detail.slice(0, 300) };
  }
}

/** Audit is best-effort on this pass: a failed write must not throw. */
async function safeAudit(
  audit: Pick<AuditService, "record">,
  logger: Pick<Logger, "warn">,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await audit.record({
      event: "SETTINGS_CHANGED",
      actorUserId: null,
      actorUsername: "auto-rotate",
      detail,
    });
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "auto-rotate audit write failed",
    );
  }
}
