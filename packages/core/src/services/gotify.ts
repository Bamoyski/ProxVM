// ---------------------------------------------------------------------------
// Gotify push notifications: admin-only fan-out alongside the in-app bell.
//
// - Config lives in DB settings (category "system"): url, token (encrypted),
//   priority (0-10, default 5), enabled flag. Nothing is sent unless enabled
//   AND url + token are both present, so a half-filled form is a no-op.
// - The token is never logged and never returned by any GET endpoint; the
//   settings route reports only `gotifyConfigured: true/false`.
// - Transport reuses the SSRF guard from util/ssrf.ts (LAN allowed by design
//   — homelab Gotify lives on 192.168.x — loopback/link-local/metadata always
//   refused, DNS re-checked per redirect hop). URL shape itself is validated
//   with the same assertSafeWebhookUrl used by the threat webhook.
// - alertAdmins() is the ticker entry point: writes the in-app notification
//   row, then pushes to Gotify. It never throws — ticker loops must survive
//   a down/unconfigured Gotify server.
// ---------------------------------------------------------------------------
import { assertSafeWebhookUrl } from "./threats.js";
import { fetchWithSsrfGuard } from "../util/ssrf.js";
import type { SettingsService } from "./settings.js";
import type { Queryable } from "../db/pool.js";
import { notify, ADMIN_AUDIENCE, type NotificationKind } from "./notifications.js";
import type { Logger } from "../util/logger.js";

export const GOTIFY_URL_KEY = "notifications.gotify_url";
export const GOTIFY_TOKEN_KEY = "notifications.gotify_token";
export const GOTIFY_PRIORITY_KEY = "notifications.gotify_priority";
export const GOTIFY_ENABLED_KEY = "notifications.gotify_enabled";
export const GOTIFY_DEFAULT_PRIORITY = 5;

export interface GotifyConfig {
  enabled: boolean;
  url: string | null;
  hasToken: boolean;
  priority: number;
}

export interface GotifyMessage {
  title: string;
  message: string;
  priority?: number;
}

/** Strip trailing slashes so `${base}/message` never doubles up. */
export function normalizeGotifyBase(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** Clamp to Gotify's 0-10 range; garbage falls back to the default. */
export function clampGotifyPriority(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : (raw as number);
  if (!Number.isInteger(n) || n < 0 || n > 10) return GOTIFY_DEFAULT_PRIORITY;
  return n;
}

export async function getGotifyConfig(
  settings: Pick<SettingsService, "getPlain">,
): Promise<GotifyConfig> {
  const [enabledRaw, urlRaw, token, priorityRaw] = await Promise.all([
    settings.getPlain(GOTIFY_ENABLED_KEY),
    settings.getPlain(GOTIFY_URL_KEY),
    settings.getPlain(GOTIFY_TOKEN_KEY),
    settings.getPlain(GOTIFY_PRIORITY_KEY),
  ]);
  const url = urlRaw?.trim() ? normalizeGotifyBase(urlRaw) : null;
  return {
    enabled: (enabledRaw ?? "false") === "true",
    url,
    hasToken: !!token?.trim(),
    priority: clampGotifyPriority(priorityRaw ?? GOTIFY_DEFAULT_PRIORITY),
  };
}

type GotifyPost = (url: string, body: unknown) => Promise<void>;

async function defaultGotifyPost(url: string, body: unknown): Promise<void> {
  const res = await fetchWithSsrfGuard(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    },
    1,
  );
  if (!res.ok) throw new Error(`Gotify POST failed with status ${res.status}`);
}

/**
 * Push one message to Gotify. No-op (sent:false) unless enabled with both
 * url and token configured. Throws on transport errors so callers can log;
 * use alertAdmins() from tickers to never throw.
 */
export async function sendGotifyMessage(
  settings: Pick<SettingsService, "getPlain">,
  msg: GotifyMessage,
  post: GotifyPost = defaultGotifyPost,
): Promise<{ sent: boolean }> {
  const [enabledRaw, urlRaw, token, priorityRaw] = await Promise.all([
    settings.getPlain(GOTIFY_ENABLED_KEY),
    settings.getPlain(GOTIFY_URL_KEY),
    settings.getPlain(GOTIFY_TOKEN_KEY),
    settings.getPlain(GOTIFY_PRIORITY_KEY),
  ]);
  if ((enabledRaw ?? "false") !== "true") return { sent: false };
  if (!urlRaw?.trim() || !token?.trim()) return { sent: false };
  const base = normalizeGotifyBase(assertSafeWebhookUrl(urlRaw));
  const priority = msg.priority !== undefined ? clampGotifyPriority(msg.priority) : clampGotifyPriority(priorityRaw ?? GOTIFY_DEFAULT_PRIORITY);
  const title = msg.title.trim().slice(0, 200) || "ProxVM notification";
  await post(`${base}/message?token=${encodeURIComponent(token.trim())}`, {
    title,
    message: msg.message.slice(0, 4000),
    priority,
  });
  return { sent: true };
}

/**
 * Admin fan-out: in-app bell row + Gotify push. Never throws; failures are
 * logged with status only (the token must never reach logs).
 */
export async function alertAdmins(
  db: Queryable,
  settings: Pick<SettingsService, "getPlain">,
  logger: Pick<Logger, "warn">,
  input: { kind?: NotificationKind; title: string; body?: string | null; link?: string | null; priority?: number },
  post?: GotifyPost,
): Promise<void> {
  try {
    await notify(db, {
      audience: ADMIN_AUDIENCE,
      kind: input.kind ?? "system",
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    });
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "admin notification write failed",
    );
  }
  try {
    await sendGotifyMessage(settings, {
      title: input.title,
      message: input.body ?? input.title,
      priority: input.priority,
    }, post);
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "gotify push failed",
    );
  }
}
